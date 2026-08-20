import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { casUpdate, type CasStore, type CasUpdateOptions } from "./cas.js";
import type { ResolvedPluginConfig } from "./config.js";
import { sessionKeyPrefix } from "./config.js";
import { CasConflictError, CasRetryExhaustedError, FragmentCorruptError, ManifestCorruptError, S3AccessError, S3LogError, StaleFragmentSeqError } from "./errors.js";
import {
  fragmentKey,
  jsonLine,
  parseFragment,
  seqFromFragmentKey,
  serializeFragment,
  sha256Hex,
} from "./fragment.js";
import {
  emptyManifest,
  parseManifestBuffer,
  serializeManifestBuffer,
  type FragmentRef,
  type Manifest,
} from "./manifest.js";

export interface S3SessionLogOptions {
  flushThresholdEvents?: number;
  flushThresholdBytes?: number;
  cas?: CasUpdateOptions;
}

export interface S3SessionLogStats {
  totalEvents: number;
  totalBytes: number;
  fragmentCount: number;
  pendingEvents: number;
}

const DEFAULT_FLUSH_EVENTS = 50;
const DEFAULT_FLUSH_BYTES = 262144;
const MANIFEST_KEY = "manifest.json";
const MAX_FRAGMENT_PUT_RETRIES = 10;

/** HTTP If-Match / If-None-Match require a quoted entity-tag (RFC 9110). */
export function quoteEtag(etag: string | undefined): string {
  if (!etag) return "";
  const trimmed = etag.trim();
  if (trimmed === "*" || trimmed.startsWith('"') || trimmed.startsWith("W/\"")) return trimmed;
  return `"${trimmed}"`;
}

export function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const meta = (error as { $metadata?: { httpStatusCode?: number } }).$metadata;
  return meta?.httpStatusCode;
}

function nameOf(error: unknown): string {
  if (error instanceof Error) return error.name;
  return "";
}

function codeOf(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";
  const rec = error as { Code?: string; code?: string };
  return rec.Code ?? rec.code ?? "";
}

export function isNotFound(error: unknown): boolean {
  const status = statusOf(error);
  const name = nameOf(error);
  const code = codeOf(error);
  return (
    status === 404 ||
    name === "NoSuchKey" ||
    name === "NotFound" ||
    code === "NoSuchKey" ||
    code === "NotFound"
  );
}

export function isPreconditionFailed(error: unknown): boolean {
  const status = statusOf(error);
  const name = nameOf(error);
  const code = codeOf(error);
  return status === 412 || name === "PreconditionFailed" || name === "412" || code === "PreconditionFailed";
}

function wrapS3(error: unknown, action: string, key: string): never {
  if (error instanceof CasConflictError || error instanceof S3AccessError) throw error;
  const status = statusOf(error);
  const message = error instanceof Error ? error.message : String(error);
  throw new S3AccessError(`${action} ${key} failed: ${message}`, status, {
    cause: error instanceof Error ? error : undefined,
  });
}

export class S3CasStore implements CasStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
    private readonly keyPrefix: string,
  ) {}

  fullKey(key: string): string {
    return `${this.keyPrefix}${key.replace(/^\/+/, "")}`;
  }

  async get(key: string): Promise<{ body: Buffer; etag: string } | null> {
    const objectKey = this.fullKey(key);
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      );
      const bytes = out.Body ? await out.Body.transformToByteArray() : new Uint8Array();
      return { body: Buffer.from(bytes), etag: quoteEtag(out.ETag) };
    } catch (error) {
      if (isNotFound(error)) return null;
      wrapS3(error, "GET", objectKey);
    }
  }

  async putIfAbsent(key: string, body: Buffer): Promise<string> {
    return this.put(key, body, { ifNoneMatch: "*" });
  }

  async putIfMatch(key: string, body: Buffer, etag: string): Promise<string> {
    return this.put(key, body, { ifMatch: etag });
  }

  async delete(key: string): Promise<void> {
    const objectKey = this.fullKey(key);
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      );
    } catch (error) {
      if (isNotFound(error)) return;
      wrapS3(error, "DELETE", objectKey);
    }
  }

  async listKeys(prefix = ""): Promise<string[]> {
    const keys: string[] = [];
    const objectPrefix = this.fullKey(prefix);
    let token: string | undefined;
    try {
      do {
        const out = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: objectPrefix,
            ContinuationToken: token,
          }),
        );
        for (const obj of out.Contents ?? []) {
          if (!obj.Key) continue;
          keys.push(obj.Key.slice(this.keyPrefix.length));
        }
        token = out.IsTruncated === true ? out.NextContinuationToken : undefined;
      } while (token);
      return keys;
    } catch (error) {
      wrapS3(error, "LIST", objectPrefix);
    }
  }

  private async put(
    key: string,
    body: Buffer,
    cond: { ifMatch?: string; ifNoneMatch?: string },
  ): Promise<string> {
    const objectKey = this.fullKey(key);
    try {
      const out = await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
          Body: body,
          ContentType: key.endsWith(".json") ? "application/json" : "application/x-ndjson",
          ...(cond.ifMatch ? { IfMatch: quoteEtag(cond.ifMatch) } : {}),
          ...(cond.ifNoneMatch ? { IfNoneMatch: cond.ifNoneMatch } : {}),
        }),
      );
      const etag = quoteEtag(out.ETag);
      if (!etag) {
        throw new S3AccessError(`PUT ${objectKey} succeeded without an ETag`);
      }
      return etag;
    } catch (error) {
      if (isPreconditionFailed(error)) throw new CasConflictError(`412 on ${objectKey}`);
      wrapS3(error, "PUT", objectKey);
    }
  }
}

export function createS3Client(config: ResolvedPluginConfig): S3Client {
  const clientConfig: S3ClientConfig = {
    region: config.region,
    forcePathStyle: config.forcePathStyle,
  };
  if (config.endpoint) clientConfig.endpoint = config.endpoint;
  if (config.accessKeyId && config.secretAccessKey) {
    clientConfig.credentials = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    };
  }
  return new S3Client(clientConfig);
}

export function createS3CasStore(config: ResolvedPluginConfig, sessionId: string, client?: S3Client): S3CasStore {
  return new S3CasStore(
    client ?? createS3Client(config),
    config.bucket,
    sessionKeyPrefix(config.prefix, sessionId),
  );
}

/**
 * Next fragment seq that is free on the store: max(floor, maxOccupied+1).
 * Used after a 412 so a run of crash-orphans does not burn the retry budget
 * one seq at a time.
 */
export async function nextFreeFragmentSeq(store: CasStore, floor: number): Promise<number> {
  const keys = await store.listKeys("fragments/");
  let maxOccupied = 0;
  for (const key of keys) {
    const seq = seqFromFragmentKey(key);
    if (seq !== null) maxOccupied = Math.max(maxOccupied, seq);
  }
  return Math.max(floor, maxOccupied + 1);
}

/**
 * Append `ref` to a manifest. Idempotent on seq+sha and on tail sha256.
 * Throws StaleFragmentSeqError if `ref.seq` is at or below the committed tail
 * (caller must re-PUT at a higher ordinal).
 */
export function appendFragmentRef(manifest: Manifest, ref: FragmentRef): Manifest {
  const existing = manifest.fragments.find((f) => f.seq === ref.seq);
  if (existing) {
    if (existing.sha256 === ref.sha256) return manifest;
    throw new StaleFragmentSeqError(ref.seq, existing.seq);
  }
  const last = manifest.fragments[manifest.fragments.length - 1];
  if (last && last.sha256 === ref.sha256 && last.events === ref.events) return manifest;
  if (last && ref.seq <= last.seq) {
    throw new StaleFragmentSeqError(ref.seq, last.seq);
  }
  return {
    ...manifest,
    fragments: [...manifest.fragments, ref],
    total_events: manifest.total_events + ref.events,
    total_bytes: manifest.total_bytes + ref.bytes,
    updated_at: new Date().toISOString(),
  };
}

export async function publishFragment(
  store: CasStore,
  sessionId: string,
  body: Buffer,
  eventCount: number,
  casOpts: CasUpdateOptions | undefined,
  mutate: (base: Manifest, ref: FragmentRef) => Manifest,
): Promise<Manifest> {
  const digest = sha256Hex(body);
  const existing = await store.get(MANIFEST_KEY);
  const start = existing ? parseManifestBuffer(existing.body) : emptyManifest(sessionId);
  const last = start.fragments[start.fragments.length - 1];
  if (last && last.sha256 === digest && last.events === eventCount) {
    return start;
  }

  let seq = (last?.seq ?? 0) + 1;
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_FRAGMENT_PUT_RETRIES; attempt++) {
    const key = fragmentKey(seq);
    try {
      await store.putIfAbsent(key, body);
    } catch (error) {
      if (!(error instanceof CasConflictError)) throw error;
      lastError = error;
      if (attempt === MAX_FRAGMENT_PUT_RETRIES) break;
      seq = await bumpFragmentSeq(store, seq);
      continue;
    }

    const ref: FragmentRef = {
      seq,
      key,
      bytes: body.byteLength,
      sha256: digest,
      events: eventCount,
    };
    try {
      const updated = await casUpdate(
        store,
        MANIFEST_KEY,
        (current) => mutate(current ?? emptyManifest(sessionId), ref),
        parseManifestBuffer,
        serializeManifestBuffer,
        casOpts,
      );
      return updated.value;
    } catch (error) {
      if (!(error instanceof StaleFragmentSeqError)) throw error;
      lastError = error;
      if (attempt === MAX_FRAGMENT_PUT_RETRIES) break;
      seq = await bumpFragmentSeq(store, seq);
    }
  }
  const exhausted = new CasRetryExhaustedError(MANIFEST_KEY, MAX_FRAGMENT_PUT_RETRIES + 1);
  if (lastError instanceof Error) exhausted.cause = lastError;
  throw exhausted;
}

async function bumpFragmentSeq(store: CasStore, seq: number): Promise<number> {
  const live = await store.get(MANIFEST_KEY);
  const tail = live
    ? (parseManifestBuffer(live.body).fragments.at(-1)?.seq ?? 0)
    : 0;
  return nextFreeFragmentSeq(store, Math.max(tail + 1, seq + 1));
}

export class S3SessionLog {
  private buffer: unknown[] = [];
  private bufferBytes = 0;
  private manifest: Manifest;
  private readonly flushThresholdEvents: number;
  private readonly flushThresholdBytes: number;
  private readonly casOpts?: CasUpdateOptions;
  private flushTail: Promise<void> = Promise.resolve();

  constructor(
    readonly store: CasStore,
    readonly sessionId: string,
    opts?: S3SessionLogOptions,
    manifest?: Manifest,
  ) {
    this.flushThresholdEvents = opts?.flushThresholdEvents ?? DEFAULT_FLUSH_EVENTS;
    this.flushThresholdBytes = opts?.flushThresholdBytes ?? DEFAULT_FLUSH_BYTES;
    this.casOpts = opts?.cas;
    this.manifest = manifest ?? emptyManifest(sessionId);
  }

  static async open(
    store: CasStore,
    sessionId: string,
    opts?: S3SessionLogOptions,
  ): Promise<S3SessionLog> {
    const existing = await store.get(MANIFEST_KEY);
    if (!existing) {
      const created = await casUpdate(
        store,
        MANIFEST_KEY,
        (current) => current ?? emptyManifest(sessionId),
        parseManifestBuffer,
        serializeManifestBuffer,
        opts?.cas,
      );
      return new S3SessionLog(store, sessionId, opts, created.value);
    }
    const parsed = parseManifestBuffer(existing.body);
    if (parsed.session_id !== sessionId) {
      throw new ManifestCorruptError(
        `manifest session_id "${parsed.session_id}" does not match open("${sessionId}")`,
      );
    }
    return new S3SessionLog(store, sessionId, opts, parsed);
  }

  append(event: unknown): void {
    const encoded = Buffer.byteLength(jsonLine(event), "utf8") + 1;
    this.buffer.push(event);
    this.bufferBytes += encoded;
  }

  shouldFlush(): boolean {
    if (this.buffer.length === 0) return false;
    return (
      this.buffer.length >= this.flushThresholdEvents ||
      this.bufferBytes >= this.flushThresholdBytes
    );
  }

  async flush(): Promise<void> {
    const run = this.flushTail.then(
      () => this.flushOnce(),
      () => this.flushOnce(),
    );
    this.flushTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async flushOnce(): Promise<void> {
    if (this.buffer.length === 0) return;

    const count = this.buffer.length;
    const events = this.buffer.slice(0, count);
    const body = serializeFragment(events);
    this.manifest = await publishFragment(
      this.store,
      this.sessionId,
      body,
      events.length,
      this.casOpts,
      (base, ref) => appendFragmentRef(base, ref),
    );
    this.dropFlushed(count);
  }

  async readAll(): Promise<unknown[]> {
    const events: unknown[] = [];
    for await (const event of this.readFrom(1)) {
      events.push(event);
    }
    return events;
  }

  async *readFrom(seqStart: number): AsyncGenerator<unknown> {
    await this.reloadManifest();
    for (const ref of this.manifest.fragments) {
      if (ref.seq < seqStart) continue;
      const events = await this.readFragment(ref);
      for (const event of events) yield event;
    }
  }

  async trim(keepLastNFragments: number): Promise<void> {
    if (!Number.isInteger(keepLastNFragments) || keepLastNFragments < 0) {
      throw new S3LogError(
        `trim keepLastNFragments must be a non-negative integer`,
        "TRIM",
      );
    }
    await this.flush();
    await this.reloadManifest();
    if (keepLastNFragments === 0) {
      // drop everything
    } else if (this.manifest.fragments.length <= keepLastNFragments) {
      return;
    }

    const kept =
      keepLastNFragments === 0 ? [] : this.manifest.fragments.slice(-keepLastNFragments);
    const dropped =
      keepLastNFragments === 0
        ? this.manifest.fragments.slice()
        : this.manifest.fragments.slice(0, -keepLastNFragments);
    if (dropped.length === 0) return;
    for (const ref of kept) {
      await this.readFragment(ref);
    }

    const droppedSeqs = new Set(dropped.map((f) => f.seq));

    const updated = await casUpdate(
      this.store,
      MANIFEST_KEY,
      (current) => {
        const manifest = current ?? emptyManifest(this.sessionId);
        const nextFragments = manifest.fragments.filter((f) => !droppedSeqs.has(f.seq));
        return {
          ...manifest,
          fragments: nextFragments,
          total_events: nextFragments.reduce((sum, f) => sum + f.events, 0),
          total_bytes: nextFragments.reduce((sum, f) => sum + f.bytes, 0),
          updated_at: new Date().toISOString(),
        };
      },
      parseManifestBuffer,
      serializeManifestBuffer,
      this.casOpts,
    );
    this.manifest = updated.value;

    for (const ref of dropped) {
      await this.store.delete(ref.key);
    }
  }

  async close(): Promise<void> {
    await this.flush();
  }

  get pending(): readonly unknown[] {
    return this.buffer;
  }

  get stats(): S3SessionLogStats {
    return {
      totalEvents: this.manifest.total_events + this.buffer.length,
      totalBytes: this.manifest.total_bytes + this.bufferBytes,
      fragmentCount: this.manifest.fragments.length,
      pendingEvents: this.buffer.length,
    };
  }

  private dropFlushed(count: number): void {
    this.buffer = this.buffer.slice(count);
    this.bufferBytes = this.buffer.reduce<number>(
      (sum, event) => sum + Buffer.byteLength(jsonLine(event), "utf8") + 1,
      0,
    );
  }

  private nextSeq(): number {
    const last = this.manifest.fragments[this.manifest.fragments.length - 1];
    return last ? last.seq + 1 : 1;
  }

  private async reloadManifest(): Promise<void> {
    const existing = await this.store.get(MANIFEST_KEY);
    this.manifest = existing ? parseManifestBuffer(existing.body) : emptyManifest(this.sessionId);
  }

  private async readFragment(ref: FragmentRef): Promise<unknown[]> {
    const object = await this.store.get(ref.key);
    if (!object) {
      throw new FragmentCorruptError(`fragment missing: ${ref.key}`);
    }
    if (sha256Hex(object.body) !== ref.sha256) {
      throw new FragmentCorruptError(`fragment sha256 mismatch: ${ref.key}`);
    }
    return parseFragment(object.body);
  }
}
