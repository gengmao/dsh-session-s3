# SPEC.md — dsh-session-s3

Community DSH plugin: S3-backed SessionPersistence provider ("wal3-Lite").
Immutable fragments + CAS manifest. Per-fragment SHA-256. No setsum (Phase 2+).

Language: TypeScript (ESM, Node >= 18). Deps: `@aws-sdk/client-s3`, `zod`. Dev: vitest, typescript.

## 1. Repository layout

```
dsh-session-s3/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── cordis.yml
├── README.md
├── src/
│   ├── index.ts            # plugin entry, exports provider factory
│   ├── config.ts           # config schema + loud validation (zod)
│   ├── errors.ts           # error taxonomy
│   ├── fragment.ts         # JSONL fragment serialize/parse + sha256
│   ├── manifest.ts         # manifest schema, parse/serialize, validation
│   ├── cas.ts              # CAS retry loop primitive
│   ├── s3log.ts            # core log engine (append/flush/read/trim/checkpoint/resume)
│   └── provider.ts         # DSH SessionPersistence provider implementation
└── test/
    ├── fragment.test.ts
    ├── manifest.test.ts
    ├── cas.test.ts
    ├── s3log.test.ts       # mocked S3, crash-resume, trim
    └── provider.test.ts    # mocked s3log
```

## 2. S3 object layout

```
s3://{bucket}/{prefix}sessions/{sessionId}/
├── manifest.json
├── fragments/{seq8}.jsonl        # seq zero-padded to 8: 00000001.jsonl
└── checkpoints/cp-{seq8}.json
```

## 3. Manifest schema (manifest.ts)

```ts
interface FragmentRef { seq: number; key: string; bytes: number; sha256: string; events: number }
interface CheckpointRef { at_seq: number; blob: string; sha256: string }
interface Manifest {
  version: 1;
  session_id: string;
  fragments: FragmentRef[];       // ordered ascending by seq
  total_events: number;
  total_bytes: number;
  checkpoint: CheckpointRef | null;
  updated_at: string;             // ISO-8601
}
```
- `parseManifest(json: string): Manifest` — throws `ManifestCorruptError` on invalid.
- `serializeManifest(m: Manifest): string`.
- `emptyManifest(sessionId: string): Manifest`.

## 4. Fragment format (fragment.ts)

JSONL: one JSON event per line, `\n`-terminated. No length-prefixing in Phase 1.
- `serializeFragment(events: unknown[]): Buffer`
- `parseFragment(buf: Buffer): unknown[]` — throws `FragmentCorruptError` if any line fails JSON.parse.
- `sha256Hex(buf: Buffer): string`.
- `fragmentKey(seq: number): string` → `fragments/${seq.toString().padStart(8,'0')}.jsonl`
- `checkpointKey(seq: number): string` → `checkpoints/cp-${...}.json`

## 5. Errors (errors.ts)

```
S3LogError (base, extends Error, has .code)
├── ConfigError            # invalid plugin config — loud, at load()
├── ManifestCorruptError   # manifest.json unparsable / schema-invalid
├── FragmentCorruptError   # fragment unparsable or sha256 mismatch
├── CasRetryExhaustedError # CAS failed after maxRetries (default 10)
└── S3AccessError          # 403/404/network, wraps original, .statusCode
```

## 6. CAS primitive (cas.ts)

```ts
interface CasStore {
  get(key: string): Promise<{ body: Buffer; etag: string } | null>;
  putIfAbsent(key: string, body: Buffer): Promise<string /*etag*/>;   // If-None-Match: * ; throws CasConflictError-ish on 412
  putIfMatch(key: string, body: Buffer, etag: string): Promise<string>; // If-Match; throws on 412
}
async function casUpdate<T>(
  store: CasStore, key: string,
  mutate: (current: T | null) => T,
  parse: (b: Buffer) => T, serialize: (t: T) => Buffer,
  opts?: { maxRetries?: number }   // default 10, exponential backoff 25ms * 2^n + jitter
): Promise<{ value: T; etag: string }>
```
Behavior: loop — get, mutate, putIfMatch (or putIfAbsent when null); on 412 re-read and retry; after maxRetries throw `CasRetryExhaustedError`.

## 7. S3 adapter (s3client.ts — part of s3log.ts module scope)

Implement `CasStore` over `@aws-sdk/client-s3` `S3Client`:
- get → GetObjectCommand, catch NoSuchKey/404 → null; etag from ETag (strip quotes).
- putIfAbsent → PutObjectCommand IfNoneMatch: '*'.
- putIfMatch → PutObjectCommand IfMatch: etag.
- 412 → throw internal `CasConflict`; 403/404-other/network → `S3AccessError`.
- Constructor config: `{ bucket, prefix?, region?, endpoint?, forcePathStyle?, credentials? }`.

## 8. Core engine (s3log.ts)

```ts
class S3SessionLog {
  constructor(store: CasStore, sessionId: string, opts?: {
    flushThresholdEvents?: number;   // default 50
    flushThresholdBytes?: number;    // default 262144 (256 KiB)
  })
  static async open(store, sessionId, opts?): Promise<S3SessionLog>  // loads manifest (or creates empty)
  append(event: unknown): void                        // buffer only, never touches S3
  async flush(): Promise<void>                        // see write flow
  async readAll(): Promise<unknown[]>                 // manifest → fragments in order, verify sha256 each
  async *readFrom(seqStart: number): AsyncGenerator<unknown>  // partial replay
  async checkpoint(state: unknown): Promise<void>     // PUT checkpoint blob, CAS manifest.checkpoint
  async resume(): Promise<{ state: unknown | null; events: unknown[] }>
                                                    // latest checkpoint + events after at_seq
  async trim(keepLastNFragments: number): Promise<void>
                                                    // delete older fragments, CAS manifest, verify kept sha256 first
  async close(): Promise<void>                        // final flush
  readonly stats: { totalEvents: number; totalBytes: number; fragmentCount: number }
}
```

Write flow (flush):
1. If buffer empty → no-op.
2. Serialize buffer as fragment, seq = last fragment seq + 1 (or 1).
3. `putIfAbsent(fragmentKey(seq), buf)` — if 412 conflict: re-open manifest, recompute seq, retry (max 10).
4. `casUpdate` on `manifest.json`: append FragmentRef {seq, key, bytes, sha256, events: buffer.length}, bump totals, set updated_at.
5. Clear buffer only after CAS succeeds.

Invariants: fragments immutable; manifest.json is the single CAS coordination point; buffer flush is atomic at fragment granularity — a crash before step 4 leaves an orphan fragment (harmless, overwritten-by-conflict path on next open; manifest is source of truth).

## 9. DSH provider (provider.ts)

Implements the DSH `SessionPersistence` service definition (packages/session seam):

```ts
interface SessionPersistenceProvider {
  load(sessionId: string): Promise<void>;
  append(sessionId: string, event: SessionEvent): Promise<void>;
  read(sessionId: string): Promise<SessionEvent[]>;
  compact(sessionId: string, keepLastN?: number): Promise<void>;
  close(sessionId: string): Promise<void>;
}
createProvider(config: PluginConfig): SessionPersistenceProvider
```
- `load`: validate config (throw ConfigError loudly), build S3 client, S3SessionLog.open. Cache per-session instances in a Map.
- `append`: log.append + flush when thresholds hit.
- `read`: readAll.
- `compact`: trim (default keepLastN = 10).
- `close`: final flush, evict from cache.
- `SessionEvent` treated as opaque JSON-serializable object (type: `Record<string, unknown>`).
- NOTE: exact DSH interface to be reconciled against real packages/session at integration time; keep provider.ts thin and isolated for that reason.

## 10. Config (config.ts + cordis.yml)

```ts
interface PluginConfig {
  bucket: string;                    // required
  prefix?: string;                   // default "dsh/"
  region?: string;                   // default "auto"
  endpoint?: string;                 // for R2/GCS/Tigris/SeaweedFS/MinIO
  forcePathStyle?: boolean;          // default true when endpoint set
  accessKeyId?: string;              // else env AWS_ACCESS_KEY_ID / default chain
  secretAccessKey?: string;
  flushThresholdEvents?: number;     // default 50
  flushThresholdBytes?: number;      // default 262144
}
```
- Validate with zod at load; missing bucket → ConfigError listing every problem.
- cordis.yml: service registration `dsh-session-persistence-s3`, config schema mirroring the above.

## 11. Tests (vitest, all with in-memory mock CasStore unless noted)

- fragment: round-trip; corrupt line → FragmentCorruptError; key padding.
- manifest: round-trip; invalid json/schema → ManifestCorruptError.
- cas: conflict-once-then-succeed retries; maxRetries → CasRetryExhaustedError.
- s3log:
  - append+flush writes fragment + manifest CAS;
  - crash-resume: append 100, flush, append 10 without flush, re-open → 100 events, buffer loss is clean (no corruption);
  - orphan fragment on open is ignored (manifest is truth);
  - sha256 mismatch on read → FragmentCorruptError;
  - trim keeps last N, deletes older, manifest consistent;
  - checkpoint + resume replays only post-checkpoint events;
  - concurrent flush simulation: two S3SessionLog instances on same mock store with injected 412 → both succeed via retry.
- provider: config validation loud-fails; append/read/compact/close delegate correctly (mock S3SessionLog or mock store).
- Integration (env-gated `S3_IT=1`, MinIO): real round-trip. Skipped by default.

## 12. Out of scope (Phase 2+)

Setsum/global log verification, verified GC, DynamoDB Streams notifications, binary fragment format.
