# dsh-session-s3

Community [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin: an S3-backed **SessionPersistence** provider.

wal3-Lite: **immutable JSONL fragments** + a **CAS manifest** (`If-None-Match` / `If-Match`). Per-fragment SHA-256. No setsum in Phase 1.

Fixes the class of JSONL durability bugs that come from torn writes, missing fsync, and concurrent writers — by never mutating a fragment and coordinating writers on a single compare-and-swap object.

The 7 field-confirmed DSH corruption discussions ([#1333](https://github.com/deepseek-ai/deepseek-harness/discussions/1333), [#1452](https://github.com/deepseek-ai/deepseek-harness/discussions/1452), [#1497](https://github.com/deepseek-ai/deepseek-harness/discussions/1497), [#1473](https://github.com/deepseek-ai/deepseek-harness/discussions/1473), [#1586](https://github.com/deepseek-ai/deepseek-harness/discussions/1586), [#2167](https://github.com/deepseek-ai/deepseek-harness/discussions/2167), [#2342](https://github.com/deepseek-ai/deepseek-harness/discussions/2342)) are encoded as tests in `test/corruption-scenarios.test.ts`. Results: [docs/corruption-scenarios.md](docs/corruption-scenarios.md).

## Install

```bash
npm install dsh-session-s3
# or from this repo
dsh plugin add "link:$PWD"
```

Requires Node >= 18.

## Config

| Key | Default | Notes |
| --- | --- | --- |
| `bucket` | *(required)* | S3 bucket |
| `prefix` | `dsh/` | Keys live at `{prefix}sessions/{sessionId}/` |
| `region` | `auto` | AWS region, or `auto` for R2 |
| `endpoint` | — | R2 / Tigris / MinIO / SeaweedFS / GCS interop |
| `forcePathStyle` | `true` when `endpoint` is set | Path-style URLs |
| `accessKeyId` / `secretAccessKey` | env `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, else the default chain | |
| `flushThresholdEvents` | `50` | Flush the in-memory buffer after N events |
| `flushThresholdBytes` | `262144` | …or after 256 KiB |

Invalid config **fails loud at load**, listing every problem (not just the first).

```ts
import { createProvider } from "dsh-session-s3";

const persistence = createProvider({
  bucket: "my-sessions",
  endpoint: process.env.S3_ENDPOINT, // e.g. http://127.0.0.1:9000 for MinIO
  region: "auto",
});

await persistence.append("sess-1", { type: "user/message", text: "hi" });
const events = await persistence.read("sess-1");
await persistence.compact("sess-1", 10);
await persistence.close("sess-1");
```

See `cordis.yml` and `cordis.patch.yml` for DSH profile wiring.

## Object layout

```
s3://{bucket}/{prefix}sessions/{sessionId}/
├── manifest.json                 # CAS coordination point
├── fragments/00000001.jsonl      # immutable, SHA-256 in the manifest
└── checkpoints/cp-00000001.json
```

Write path (`flush`):

1. Buffer is serialized as a JSONL fragment (`seq = last + 1`).
2. `PutObject` with `If-None-Match: *`. On 412, reload the manifest, skip the orphan seq, retry.
3. CAS-update `manifest.json` (`If-Match`) to append the fragment ref.
4. Clear the buffer only after the CAS succeeds.

A crash between (2) and (3) leaves an **orphan fragment**. Harmless: the manifest is source of truth, and the next flush skips that seq.

## S3 compatibility

| Backend | If-Match / If-None-Match | Phase 1 |
| --- | --- | --- |
| AWS S3 | yes | supported |
| Cloudflare R2 | yes | supported |
| Tigris | yes | supported |
| MinIO | yes | supported |
| GCS (S3 interop) | weak / eventual on some paths | use with care |
| SeaweedFS | version-dependent | use with care |

CAS is the correctness mechanism. Do not point this at a store that silently ignores conditional puts.

Env-gated integration test:

```bash
S3_IT=1 S3_BUCKET=test S3_ENDPOINT=http://127.0.0.1:9000 \
  AWS_ACCESS_KEY_ID=minioadmin AWS_SECRET_ACCESS_KEY=minioadmin \
  npm test
```

## Caveats

1. **DSH seam.** `SessionPersistenceProvider` here is `load` / `append` / `read` / `compact` / `close`. Upstream `SessionPersistence` (`@deepseek-ai/dsh-session-persistence`) is a Cordis `Service` with `locate` / `create` / `prepare` / `inspect` / `readFrom` / `list` / `listSnapshots`. Reconcile against the real interface before publishing this as a drop-in for `dsh-session-persistence-jsonl`.
2. **No setsum** (deliberate, Phase 2). Integrity is per-fragment SHA-256 only.

## Roadmap

- Phase 2 — setsum / global log verification, verified GC
- Phase 3 — run the 7 known DSH JSONL corruption scenarios; draft the RFC Discussion
- Optional — binary fragments, DynamoDB Streams notifications

## Develop

```bash
npm install
npm test
npm run build
```

`SPEC.md` is the Phase 1 contract.
