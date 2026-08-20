# SPEC.md — dsh-session-s3

Community DSH plugin: S3-backed SessionPersistence ("wal3-Lite").
Immutable fragments + CAS manifest. Per-fragment SHA-256. No setsum (Phase 2+).

Language: TypeScript (ESM, Node >= 18).
Deps: `@aws-sdk/client-s3`, `zod`.
Peers (provided by a DSH profile): `@deepseek-ai/cordis`, `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-session-persistence`.

## 1. Repository layout

```
dsh-session-s3/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── cordis.yml
├── cordis.patch.yml
├── README.md
├── SPEC.md
├── src/
│   ├── index.ts            # default export: S3SessionPersistence
│   ├── config.ts           # config schema + loud validation (zod)
│   ├── errors.ts           # error taxonomy
│   ├── fragment.ts         # JSONL fragment serialize/parse + sha256
│   ├── manifest.ts         # manifest schema, parse/serialize
│   ├── cas.ts              # CAS retry loop + prefixStore + listKeys
│   ├── s3log.ts            # CasStore over S3 + S3SessionLog engine
│   ├── backend.ts          # PersistenceBackend<S3TornMarker> over the WAL
│   ├── persistence.ts      # SessionPersistence + PersistenceCoordinator
│   └── provider.ts         # library helper (load/append/read/compact/close)
└── test/
    ├── fragment.test.ts
    ├── manifest.test.ts
    ├── cas.test.ts
    ├── s3log.test.ts
    ├── s3cas.test.ts
    ├── provider.test.ts
    ├── backend.test.ts
    ├── persistence.test.ts
    ├── corruption-scenarios.test.ts
    └── s3.integration.test.ts   # env-gated S3_IT=1
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
  header?: SessionHeader | null;  # DSH SessionHeader, written on first appendBatch
  fragments: FragmentRef[];       # ordered ascending by seq
  total_events: number;
  total_bytes: number;
  checkpoint: CheckpointRef | null;
  updated_at: string;             # ISO-8601
}
```

## 4. Fragment format (fragment.ts)

JSONL: one JSON event per line, `\n`-terminated.
- `jsonLine` / `serializeFragment` throw `FragmentCorruptError` if `JSON.stringify` returns `undefined` (functions, `undefined`).
- `parseFragment` throws on a non-JSON line.
- `fragmentKey(seq)` → `fragments/${seq.toString().padStart(8,'0')}.jsonl`

## 5. Errors (errors.ts)

```
S3LogError (base, extends Error, has .code)
├── ConfigError            # invalid plugin config — loud, at load
├── ManifestCorruptError   # manifest.json unparsable / schema-invalid / session_id mismatch
├── FragmentCorruptError   # fragment unparsable or sha256 mismatch
├── CasRetryExhaustedError # CAS or fragment PUT failed after maxRetries (default 10)
└── S3AccessError          # 403/404/network, wraps original, .statusCode
```

## 6. CAS primitive (cas.ts)

```ts
interface CasStore {
  get(key: string): Promise<{ body: Buffer; etag: string } | null>;
  putIfAbsent(key: string, body: Buffer): Promise<string /*etag*/>;
  putIfMatch(key: string, body: Buffer, etag: string): Promise<string>;
  delete(key: string): Promise<void>;
  listKeys(prefix?: string): Promise<string[]>;
}
```

`casUpdate`: get → mutate → putIfMatch / putIfAbsent; on 412 re-read and retry; after maxRetries throw `CasRetryExhaustedError`.

ETags on the wire are **quoted** (`If-Match: "abc"`). `quoteEtag` is idempotent.

## 7. S3 adapter (s3log.ts `S3CasStore`)

- GET 404 / NoSuchKey → `null`.
- PUT `If-None-Match: *` / `If-Match: <quoted etag>`.
- 412 → `CasConflictError`; other failures → `S3AccessError`.
- A successful PUT without an ETag is an error (never fabricate a sha256 etag).

## 8. Core engine (s3log.ts `S3SessionLog`)

Library WAL used by `createProvider` and (indirectly) by the backend.

Write flow (`flush`), serialized per log:
1. Snapshot `count = buffer.length` (later appends are kept).
2. If the live manifest tail already has this sha256, drop the snapshot (lost CAS response).
3. `putIfAbsent(fragmentKey(seq))`. On 412: reload manifest, `seq = Math.max(fromManifest, seq + 1)`, retry (max 10) then `CasRetryExhaustedError`.
4. `casUpdate` `manifest.json` (idempotent on seq and tail sha256).
5. `buffer = buffer.slice(count)`.

`open()` rejects if `manifest.session_id` ≠ the id being opened.
`trim(0)` drops every fragment (CAS first, then delete).

## 9. DSH seam (persistence.ts + backend.ts)

Same composition as `dsh-session-persistence-jsonl`:

```ts
class S3SessionPersistence
  extends SessionPersistence
  implements PersistenceBackend<S3TornMarker>
{
  constructor(ctx, config) {
    super(ctx);
    this.coordinator = new PersistenceCoordinator(this.ctx, this, options);
  }
}
```

Default export is this class. Cordis registers it as `ctx.sessionPersistence`.

Storage hooks (`S3PersistenceBackend`): `loadStored`, `readStoredRevision`, `appendBatch`, `commitRepair`, `list`, `listSnapshots`. A last-fragment sha mismatch is a torn tail (`tornMarker.dropFromSeq`); `list()` reads manifests only so one smashed fragment cannot poison workspace boot.

`appendBatch` (and the coordinator in front of it) **rejects** a batch whose first `seq` ≠ stored next-seq.

Library helper `createProvider` (`provider.ts`) is **not** the DSH seam: `load` / `append` / `read` / `compact` / `close` over `S3SessionLog`.

## 10. Config (config.ts + cordis.yml)

```ts
interface PluginConfig {
  bucket: string;                    // required
  prefix?: string;                   // default "dsh/"
  region?: string;                   // default "auto"
  endpoint?: string;                 // must be http(s) URL if set
  forcePathStyle?: boolean;          // default true when endpoint set
  accessKeyId?: string;              // else AWS_ACCESS_KEY_ID / SDK chain
  secretAccessKey?: string;
  flushThresholdEvents?: number;     // default 50
  flushThresholdBytes?: number;      // default 262144
  preparedSessionCacheSize?: number; // coordinator LRU
  writeBatchMaxDelayMs?: number;     // coordinator write-behind
}
```

cordis.yml service key: `sessionPersistence`. Bundle patch `cordis.patch.yml` replaces the profile `sessions` row.

## 11. Tests (vitest, in-memory `MemoryCasStore` unless noted)

- fragment, manifest, cas, s3log (including concurrent-append-during-flush, two-orphan seq, `trim(0)`).
- s3cas: stubbed `S3Client` for 404 / 412 / 500 / quoted `If-Match`.
- provider: library helper.
- backend: PersistenceBackend hooks, list isolation, torn tail.
- persistence: `instanceof SessionPersistence`, coordinator create/append/load/seq-mismatch, interrupted-turn closer on cold load, torn-tail inspect vs load.
- corruption-scenarios: the 7 DSH JSONL discussions.
- Integration (`S3_IT=1`): two-writer CAS + prefix cleanup. Skipped by default.

## 12. Out of scope (Phase 2+)

Setsum / global log verification, verified GC, DynamoDB Streams notifications, binary fragment format, cross-process lock around a live session.
