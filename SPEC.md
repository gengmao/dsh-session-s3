# SPEC.md — dsh-session-s3

Community DSH plugin: S3-backed SessionPersistence ("wal3-Lite").
Immutable fragments + CAS manifest. Per-fragment SHA-256. No setsum (Phase 2+).

This file is the Phase 1 behavioral contract. The reasoning behind the
protocol and its tradeoffs is in [`docs/design-rationale.md`](docs/design-rationale.md).

Language: TypeScript (ESM, **Node >= 22**; `Promise.withResolvers` polyfill for 18–21).
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
└── fragments/{seq8}.jsonl        # seq zero-padded to 8: 00000001.jsonl
```

## 3. Manifest schema (manifest.ts)

```ts
interface FragmentRef { seq: number; key: string; bytes: number; sha256: string; events: number }
interface Manifest {
  version: 1;
  session_id: string;
  header?: SessionHeader | null;  # DSH SessionHeader; malformed header is ignored
  fragments: FragmentRef[];       # ordered ascending by seq
  total_events: number;
  total_bytes: number;
  next_event_seq?: number;        # DSH event-seq watermark; trim must not decrease it
  updated_at: string;             # ISO-8601
}
```

## 4. Fragment format (fragment.ts)

JSONL: optional `{ "_dsh_frag": 1, ts, nonce }` header line, then one JSON event per line, `\n`-terminated.
- Durable flushes stamp the header so identical consecutive batches do not share a SHA-256 (lost-CAS retry still uses the same body).
- `parseFragment` skips a leading wal header; old fragments without one still parse.
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
├── StaleWriterError       # DSH backend: SessionEvent.seq ≠ next_event_seq (fallback total_events) inside manifest CAS
├── StaleFragmentSeqError  # fragment ordinal ≤ committed tail; publisher reallocates and re-PUTs
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
  listPrefixes(prefix?: string): Promise<string[]>;  // CommonPrefixes / Delimiter "/"
}
```

`casUpdate`: get → mutate → putIfMatch / putIfAbsent; on 412 / 409 `ConditionalRequestConflict` re-read and retry; after maxRetries throw `CasRetryExhaustedError`.

ETags on the wire are **quoted** (`If-Match: "abc"`). `quoteEtag` is idempotent.

## 7. S3 adapter (s3log.ts `S3CasStore`)

- GET 404 / NoSuchKey → `null`.
- PUT `If-None-Match: *` / `If-Match: <quoted etag>`.
- 412 / 409 `ConditionalRequestConflict` → `CasConflictError`; other failures → `S3AccessError`.
- A successful PUT without an ETag is an error (never fabricate a sha256 etag).

## 8. Core engine (s3log.ts `S3SessionLog`)

Library WAL used by `createProvider` and (indirectly) by the backend.

Write flow (`flush`), serialized per log:
1. Snapshot `count = buffer.length` (later appends are kept).
2. GET `manifest.json`. If the live tail already has this sha256, drop the snapshot (lost CAS response).
3. `putIfAbsent(fragmentKey(seq))`. On 412: LIST `fragments/` for the true max occupied seq, retry.
4. Conditional PUT `manifest.json` using the ETag from step 2. Reload only after a 412.

Uncontended single-writer flush is **3 S3 requests** (GET + fragment PUT + manifest PUT). `open()` is lazy (no empty manifest PUT). `open()` rejects if `manifest.session_id` ≠ the id being opened, or if the id contains `/`. `trim` refuses a session whose manifest already has a DSH `header`. `trim(0)` drops every fragment (CAS first, then delete).

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

Storage hooks (`S3PersistenceBackend`): `loadStored`, `readStoredRevision`, `appendBatch`, `commitRepair`, `list`, `listSnapshots`. A last-fragment sha mismatch is a torn tail (`tornMarker: { dropFromSeq, etag, tailSha256 }`); `commitRepair` CAS-rejects if the live etag or tail is no longer that fragment, and is a no-op (does not `putIfAbsent` an empty manifest) if the object is gone. `listSnapshots` lists `sessions/` with `Delimiter: "/"` then GETs each manifest, so one smashed fragment cannot poison workspace boot.

DSH topology is **one live writer per session**. `appendBatch` revalidates `events[0].seq === next_event_seq` (falling back to `total_events`) **inside** the manifest CAS. A stale writer is **rejected** (`StaleWriterError`); its fragment PUT is left as an unreachable orphan. `next_event_seq` is not decreased by trim; `trim` of a DSH-headed session is refused. The library helper `createProvider` / `S3SessionLog` does not interpret `SessionEvent.seq`. Concurrent library flushes reallocate a stale fragment ordinal above the committed tail (they never write `[2, 1]` into the manifest).

Library helper `createProvider` (`provider.ts`) is **not** the DSH seam: `load` / `append` / `read` / `compact` / `close` over `S3SessionLog`.

## 10. Config (config.ts + cordis.yml)

```ts
interface PluginConfig {
  bucket: string;                    // required
  prefix?: string;                   // default "dsh/"
  region?: string;                   // unset → SDK / AWS_REGION; default "auto" if endpoint set
  endpoint?: string;                 // must be http(s) URL if set
  forcePathStyle?: boolean;          // default true when endpoint set
  accessKeyId?: string;              // static keys only; else SDK default chain (includes AWS_SESSION_TOKEN)
  secretAccessKey?: string;
  flushThresholdEvents?: number;     // createProvider only; default 50
  flushThresholdBytes?: number;      // createProvider only; default 262144
  preparedSessionCacheSize?: number; // DSH coordinator LRU
  writeBatchMaxDelayMs?: number;     // DSH coordinator write-behind
}
```

cordis.yml service key: `sessionPersistence`. Bundle patch `cordis.patch.yml` replaces the profile `sessions` row.

Fragment `seq` is a one-based storage ordinal. It is independent of the
zero-based `SessionEvent.seq`; manifest CAS orders fragment references but does
not reserve event sequence numbers across processes.

## 11. Tests (vitest, in-memory `MemoryCasStore` unless noted)

- fragment, manifest, cas, s3log (including concurrent-append-during-flush, two-orphan seq, `trim(0)`, stale fragment ordinal reallocated above the tail).
- s3cas: stubbed `S3Client` for 404 / 412 / 409 `ConditionalRequestConflict` / 500 / quoted `If-Match`.
- provider: library helper.
- backend: PersistenceBackend hooks, list isolation, torn tail, **stale-writer fail-closed inside CAS**, lost-response after committed CAS, **commitRepair refuses to drop a newer tail**.
- persistence: `instanceof SessionPersistence`, coordinator create/append/load/seq-mismatch, interrupted-turn closer on cold load, torn-tail inspect vs load.
- corruption-scenarios: the 7 DSH JSONL discussions.
- Integration (`S3_IT=1`): two-writer CAS + prefix cleanup. Skipped by default.

## 12. Out of scope (Phase 2+)

Setsum / global log verification, verified GC, DynamoDB Streams notifications, binary fragment format, cross-process lock around a live session.
