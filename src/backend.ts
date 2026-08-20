import type { SessionEvent, SessionHeader, SessionId } from "@deepseek-ai/dsh-session";
import { SessionId as asSessionId } from "@deepseek-ai/dsh-session";
import {
  SessionPersistenceRevision,
  type PersistenceBackend,
  type SessionLocation,
  type SessionPersistenceSnapshot,
  type StoredPrefix,
} from "@deepseek-ai/dsh-session-persistence";
import { casUpdate, prefixStore, type CasStore, type CasUpdateOptions } from "./cas.js";
import { sessionKeyPrefix, type ResolvedPluginConfig } from "./config.js";
import { CasConflictError, CasRetryExhaustedError, FragmentCorruptError, S3LogError } from "./errors.js";
import { fragmentKey, parseFragment, serializeFragment, sha256Hex } from "./fragment.js";
import {
  emptyManifest,
  parseManifestBuffer,
  serializeManifestBuffer,
  type FragmentRef,
  type Manifest,
} from "./manifest.js";
import { createS3CasStore, createS3Client, nextFreeFragmentSeq, S3CasStore } from "./s3log.js";

const MANIFEST_KEY = "manifest.json";
const MAX_FRAGMENT_PUT_RETRIES = 10;
const SESSION_MANIFEST_RE = /^sessions\/([^/]+)\/manifest\.json$/;

export interface S3TornMarker {
  dropFromSeq: number;
}

export interface S3PersistenceBackendOptions {
  root?: CasStore;
  createStore?: (sessionId: string) => CasStore;
  cas?: CasUpdateOptions;
}

function asEvent(value: unknown): SessionEvent {
  if (typeof value !== "object" || value === null) {
    throw new FragmentCorruptError("fragment event is not an object");
  }
  const rec = value as SessionEvent;
  if (typeof rec.seq !== "number" || typeof rec.type !== "string") {
    throw new FragmentCorruptError("fragment event missing seq/type");
  }
  return rec;
}

function asHeader(value: unknown): SessionHeader | null {
  if (typeof value !== "object" || value === null) return null;
  const rec = value as SessionHeader;
  if (typeof rec.id !== "string") return null;
  return structuredClone(rec) as SessionHeader;
}

function headerFromManifest(manifest: Manifest, sessionId: string): SessionHeader | null {
  const fromStore = asHeader(manifest.header);
  if (fromStore) return fromStore;
  if (manifest.fragments.length === 0) return null;
  return { version: 0, id: asSessionId(sessionId), createdAt: 0 };
}

export class S3PersistenceBackend implements PersistenceBackend<S3TornMarker> {
  readonly name = "session-persistence-s3";
  private readonly root: CasStore;
  private readonly storeFor: (sessionId: string) => CasStore;
  private readonly cas?: CasUpdateOptions;

  constructor(
    private readonly config: ResolvedPluginConfig,
    opts?: S3PersistenceBackendOptions,
  ) {
    this.cas = opts?.cas;
    if (opts?.root && opts.createStore) {
      this.root = opts.root;
      this.storeFor = opts.createStore;
      return;
    }
    const client = createS3Client(config);
    this.root = opts?.root ?? new S3CasStore(client, config.bucket, config.prefix);
    this.storeFor =
      opts?.createStore ??
      ((sessionId) => createS3CasStore(config, sessionId, client));
  }

  static fromMemory(
    config: ResolvedPluginConfig,
    bucket: CasStore,
    cas?: CasUpdateOptions,
  ): S3PersistenceBackend {
    return new S3PersistenceBackend(config, {
      root: prefixStore(bucket, config.prefix),
      createStore: (id) => prefixStore(bucket, sessionKeyPrefix(config.prefix, id)),
      cas,
    });
  }

  locate(meta: SessionHeader): SessionLocation {
    return {
      kind: "s3",
      path: `s3://${this.config.bucket}/${sessionKeyPrefix(this.config.prefix, meta.id)}`,
    };
  }

  async loadStored(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<StoredPrefix<S3TornMarker> | undefined> {
    signal?.throwIfAborted();
    const store = this.storeFor(id);
    const existing = await store.get(MANIFEST_KEY);
    signal?.throwIfAborted();
    if (!existing) return undefined;
    const manifest = parseManifestBuffer(existing.body);
    const meta = headerFromManifest(manifest, id);
    if (!meta) return undefined;
    if (meta.id !== id) {
      throw new S3LogError(
        `stored session identity mismatch: requested "${id}", header contains "${meta.id}"`,
        "IDENTITY",
      );
    }

    const events: SessionEvent[] = [];
    for (const ref of manifest.fragments) {
      signal?.throwIfAborted();
      try {
        events.push(...(await this.readFragment(store, ref)));
      } catch (error) {
        const isLast = ref === manifest.fragments[manifest.fragments.length - 1];
        if (isLast && error instanceof FragmentCorruptError) {
          return {
            meta,
            events: events.map((e) => structuredClone(e)),
            revision: this.revision(id, existing.etag),
            tornMarker: { dropFromSeq: ref.seq },
          };
        }
        throw error;
      }
    }
    return {
      meta,
      events: events.map((e) => structuredClone(e)),
      revision: this.revision(id, existing.etag),
    };
  }

  async readStoredRevision(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<SessionPersistenceRevision | undefined> {
    signal?.throwIfAborted();
    const existing = await this.storeFor(id).get(MANIFEST_KEY);
    signal?.throwIfAborted();
    if (!existing) return undefined;
    return this.revision(id, existing.etag);
  }

  async appendBatch(
    meta: SessionHeader,
    events: readonly SessionEvent[],
    _isMaterialized: boolean,
  ): Promise<void> {
    if (events.length === 0) return;
    const id = meta.id;
    const store = this.storeFor(id);
    const existing = await store.get(MANIFEST_KEY);
    const manifest = existing ? parseManifestBuffer(existing.body) : emptyManifest(id);
    const expected = manifest.total_events;
    if (events[0]!.seq !== expected) {
      throw new Error(`append seq mismatch for "${id}": expected ${expected}, got ${events[0]!.seq}`);
    }
    for (let i = 1; i < events.length; i++) {
      if (events[i]!.seq !== expected + i) {
        throw new Error(
          `append seq mismatch for "${id}": expected ${expected + i} at index ${i}, got ${events[i]!.seq}`,
        );
      }
    }

    const body = serializeFragment(events);
    const digest = sha256Hex(body);
    let seq = (manifest.fragments[manifest.fragments.length - 1]?.seq ?? 0) + 1;
    let key = fragmentKey(seq);
    for (let attempt = 0; attempt <= MAX_FRAGMENT_PUT_RETRIES; attempt++) {
      try {
        await store.putIfAbsent(key, body);
        break;
      } catch (error) {
        if (!(error instanceof CasConflictError)) throw error;
        if (attempt === MAX_FRAGMENT_PUT_RETRIES) {
          const exhausted = new CasRetryExhaustedError(key, attempt + 1);
          if (error instanceof Error) exhausted.cause = error;
          throw exhausted;
        }
        const latest = await store.get(MANIFEST_KEY);
        const live = latest ? parseManifestBuffer(latest.body) : manifest;
        const fromManifest = (live.fragments[live.fragments.length - 1]?.seq ?? 0) + 1;
        seq = await nextFreeFragmentSeq(store, Math.max(fromManifest, seq + 1));
        key = fragmentKey(seq);
      }
    }

    const ref: FragmentRef = {
      seq,
      key,
      bytes: body.byteLength,
      sha256: digest,
      events: events.length,
    };

    await casUpdate(
      store,
      MANIFEST_KEY,
      (current) => {
        const base = current ?? emptyManifest(id);
        if (base.fragments.some((f) => f.seq === ref.seq)) return base;
        const last = base.fragments[base.fragments.length - 1];
        if (last && last.sha256 === ref.sha256 && last.events === ref.events) return base;
        return {
          ...base,
          header: (base.header as Manifest["header"]) ?? (structuredClone(meta) as unknown as Manifest["header"]),
          fragments: [...base.fragments, ref],
          total_events: base.total_events + ref.events,
          total_bytes: base.total_bytes + ref.bytes,
          updated_at: new Date().toISOString(),
        };
      },
      parseManifestBuffer,
      serializeManifestBuffer,
      this.cas,
    );
  }

  async commitRepair(
    meta: SessionHeader,
    tornMarker: S3TornMarker | undefined,
    closers: readonly SessionEvent[],
  ): Promise<void> {
    if (tornMarker !== undefined) {
      const store = this.storeFor(meta.id);
      await casUpdate(
        store,
        MANIFEST_KEY,
        (current) => {
          const base = current ?? emptyManifest(meta.id);
          const kept = base.fragments.filter((f) => f.seq < tornMarker.dropFromSeq);
          return {
            ...base,
            fragments: kept,
            total_events: kept.reduce((sum, f) => sum + f.events, 0),
            total_bytes: kept.reduce((sum, f) => sum + f.bytes, 0),
            updated_at: new Date().toISOString(),
          };
        },
        parseManifestBuffer,
        serializeManifestBuffer,
        this.cas,
      );
    }
    if (closers.length > 0) {
      await this.appendBatch(meta, closers, true);
    }
  }

  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    return (await this.listSnapshots(signal)).map((s) => s.header);
  }

  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    signal?.throwIfAborted();
    const keys = await this.root.listKeys("sessions/");
    const snapshots: SessionPersistenceSnapshot[] = [];
    const seen = new Set<string>();
    for (const key of keys) {
      signal?.throwIfAborted();
      const match = SESSION_MANIFEST_RE.exec(key);
      if (!match) continue;
      const id = match[1]!;
      if (seen.has(id)) continue;
      try {
        const existing = await this.storeFor(id).get(MANIFEST_KEY);
        if (!existing) continue;
        const manifest = parseManifestBuffer(existing.body);
        const meta = headerFromManifest(manifest, id);
        if (!meta || meta.id !== id) continue;
        seen.add(id);
        snapshots.push({
          header: structuredClone(meta),
          revision: this.revision(asSessionId(id), existing.etag),
        });
      } catch {
        continue;
      }
    }
    return snapshots;
  }

  async readRaw(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<{ meta: SessionHeader; filename: string; content: string } | undefined> {
    const stored = await this.loadStored(id, signal);
    if (!stored) return undefined;
    const lines = [JSON.stringify(stored.meta), ...stored.events.map((e) => JSON.stringify(e))];
    return { meta: stored.meta, filename: "session.jsonl", content: `${lines.join("\n")}\n` };
  }

  private revision(id: string, etag: string): SessionPersistenceRevision {
    return SessionPersistenceRevision(
      `s3:${this.config.bucket}/${sessionKeyPrefix(this.config.prefix, id)}:${etag}`,
    );
  }

  private async readFragment(store: CasStore, ref: FragmentRef): Promise<SessionEvent[]> {
    const object = await store.get(ref.key);
    if (!object) throw new FragmentCorruptError(`fragment missing: ${ref.key}`);
    if (sha256Hex(object.body) !== ref.sha256) {
      throw new FragmentCorruptError(`fragment sha256 mismatch: ${ref.key}`);
    }
    return parseFragment(object.body).map(asEvent);
  }
}
