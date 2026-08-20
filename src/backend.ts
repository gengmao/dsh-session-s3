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
import { FragmentCorruptError, S3LogError, StaleWriterError } from "./errors.js";
import { parseFragment, serializeFragment, sha256Hex } from "./fragment.js";
import {
  emptyManifest,
  eventSeqWatermark,
  parseManifestBuffer,
  serializeManifestBuffer,
  type FragmentRef,
  type Manifest,
} from "./manifest.js";
import { createS3CasStore, createS3Client, appendFragmentRef, publishFragment, quoteEtag, S3CasStore } from "./s3log.js";

const MANIFEST_KEY = "manifest.json";
const SESSION_PREFIX_RE = /^sessions\/([^/]+)\/$/;

export interface S3TornMarker {
  dropFromSeq: number;
  /** Manifest ETag observed when the torn tail was diagnosed. */
  etag: string;
  /** SHA-256 of the torn last fragment as recorded in that manifest. */
  tailSha256: string;
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
            tornMarker: { dropFromSeq: ref.seq, etag: existing.etag, tailSha256: ref.sha256 },
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
    for (let i = 1; i < events.length; i++) {
      if (events[i]!.seq !== events[0]!.seq + i) {
        throw new StaleWriterError(id, events[0]!.seq + i, events[i]!.seq);
      }
    }

    const body = serializeFragment(events);
    await publishFragment(
      store,
      id,
      body,
      events.length,
      this.cas,
      (base, ref) => {
        const last = base.fragments[base.fragments.length - 1];
        if (last && last.sha256 === ref.sha256 && last.events === ref.events) return base;
        if (base.fragments.some((f) => f.seq === ref.seq && f.sha256 === ref.sha256)) return base;
        const expected = eventSeqWatermark(base);
        const got = events[0]!.seq;
        if (got !== expected) {
          throw new StaleWriterError(id, expected, got);
        }
        const next = appendFragmentRef(base, ref);
        return {
          ...next,
          next_event_seq: events[events.length - 1]!.seq + 1,
          header:
            (base.header as Manifest["header"]) ??
            (structuredClone(meta) as unknown as Manifest["header"]),
        };
      },
    );
  }

  async commitRepair(
    meta: SessionHeader,
    tornMarker: S3TornMarker | undefined,
    closers: readonly SessionEvent[],
  ): Promise<void> {
    if (tornMarker !== undefined) {
      const store = this.storeFor(meta.id);
      const existing = await store.get(MANIFEST_KEY);
      if (existing && quoteEtag(existing.etag) !== quoteEtag(tornMarker.etag)) {
        const live = parseManifestBuffer(existing.body);
        const last = live.fragments[live.fragments.length - 1]?.seq ?? 0;
        throw new StaleWriterError(meta.id, tornMarker.dropFromSeq, last);
      }
      await casUpdate(
        store,
        MANIFEST_KEY,
        (current) => {
          const base = current ?? emptyManifest(meta.id);
          const last = base.fragments[base.fragments.length - 1];
          if (!last || last.seq < tornMarker.dropFromSeq) {
            return base;
          }
          if (last.seq > tornMarker.dropFromSeq || last.sha256 !== tornMarker.tailSha256) {
            throw new StaleWriterError(meta.id, tornMarker.dropFromSeq, last.seq);
          }
          const kept = base.fragments.filter((f) => f.seq < tornMarker.dropFromSeq);
          const total_events = kept.reduce((sum, f) => sum + f.events, 0);
          return {
            ...base,
            fragments: kept,
            total_events,
            total_bytes: kept.reduce((sum, f) => sum + f.bytes, 0),
            next_event_seq: total_events,
            updated_at: new Date().toISOString(),
          };
        },
        parseManifestBuffer,
        serializeManifestBuffer,
        { ...this.cas, known: existing },
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
    const prefixes = await this.root.listPrefixes("sessions/");
    const snapshots: SessionPersistenceSnapshot[] = [];
    const seen = new Set<string>();
    for (const prefix of prefixes) {
      signal?.throwIfAborted();
      const match = SESSION_PREFIX_RE.exec(prefix);
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
