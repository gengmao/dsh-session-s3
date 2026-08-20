# dsh-session-s3

Unofficial community [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin: an S3-backed **SessionPersistence** provider.

wal3-Lite: **immutable JSONL fragments** + a **CAS manifest** (`If-None-Match` / `If-Match`). Per-fragment SHA-256. No setsum in Phase 1.

Fixes the class of JSONL durability bugs that come from torn writes, missing fsync, and concurrent writers — by never mutating a fragment and coordinating writers on a single compare-and-swap object.

The 7 field-confirmed DSH corruption discussions ([#1333](https://github.com/deepseek-ai/deepseek-harness/discussions/1333), [#1452](https://github.com/deepseek-ai/deepseek-harness/discussions/1452), [#1497](https://github.com/deepseek-ai/deepseek-harness/discussions/1497), [#1473](https://github.com/deepseek-ai/deepseek-harness/discussions/1473), [#1586](https://github.com/deepseek-ai/deepseek-harness/discussions/1586), [#2167](https://github.com/deepseek-ai/deepseek-harness/discussions/2167), [#2342](https://github.com/deepseek-ai/deepseek-harness/discussions/2342)) are encoded as tests in `test/corruption-scenarios.test.ts`. Results: [docs/corruption-scenarios.md](docs/corruption-scenarios.md).

For the correctness boundary, commit point, crash states, sequence domains,
and rejected alternatives, see [Design rationale](docs/design-rationale.md).

## Install

Plugins install into a **profile** (`$DSH_HOME/profiles/<name>`), not globally. `dsh plugin` is a pnpm forwarder: it adds the package as a dependency, and because this repo declares `dsh.bundle.patch`, it also appends `dsh-session-s3` to `dsh.profile.bundles`.

**From GitHub (typical):**

```bash
dsh plugin --profile web add github:gengmao/dsh-session-s3
```

or without a global `dsh`:

```bash
npx -y @deepseek-ai/dsh plugin --profile web add github:gengmao/dsh-session-s3
```

pnpm ≥10 blocks git-hosted `prepare` scripts (this package runs `tsc` on install). If add fails, allow the build and re-run:

```yaml
# $DSH_HOME/profiles/web/pnpm-workspace.yaml
allowBuilds:
  dsh-session-s3: true
```

**From a local checkout:**

```bash
dsh plugin --profile web add ./dsh-session-s3
# or
dsh plugin --profile web add "link:$PWD"
```

**From npm** (once published):

```bash
dsh plugin --profile web add dsh-session-s3
```

Same action in the Web UI: **Settings → Plugins**. Restart `dsh web` (or `dsh --profile web`) after adding.

Remove with `dsh plugin --profile web remove dsh-session-s3`.

Requires **Node >= 22** (`PersistenceCoordinator` uses `Promise.withResolvers`; a polyfill is loaded at import so 18–21 do not crash, but DSH itself wants 22).

Peer packages (`@deepseek-ai/dsh-session`, `dsh-session-persistence`) come from the DSH profile. A standalone `npm install` of this repo uses `.npmrc` `legacy-peer-deps=true` because `@deepseek-ai/dsh-type-meta` is unpublished on npmjs.

## Config

| Key | Default | Notes |
| --- | --- | --- |
| `bucket` | *(required)* | S3 bucket |
| `prefix` | `dsh/` | Keys live at `{prefix}sessions/{sessionId}/` |
| `region` | unset (SDK / `AWS_REGION`); `auto` if `endpoint` is set | Set explicitly for AWS; `auto` for R2 |
| `endpoint` | — | R2 / Tigris / MinIO / SeaweedFS / GCS interop (must be `http(s)`) |
| `forcePathStyle` | `true` when `endpoint` is set | Path-style URLs |
| `accessKeyId` / `secretAccessKey` | unset | Only for static keys. Prefer the SDK default chain (see below) |
| `flushThresholdEvents` | `50` | Library `createProvider()` only: flush its in-memory buffer after N events |
| `flushThresholdBytes` | `262144` | Library `createProvider()` only: flush after 256 KiB |
| `preparedSessionCacheSize` | coordinator default (5) | DSH seam: LRU of unpublished preparations |
| `writeBatchMaxDelayMs` | coordinator default (200) | DSH seam: coordinator write-behind delay |

Invalid config **fails loud at load**, listing every problem (not just the first).

The bundle patch replaces the profile `sessions` row and the default export is a Cordis `Service` registered as **`ctx.sessionPersistence`**, so Harness resume/list/the agent loop talk to S3 instead of JSONL.

After install, set the bucket (and optional endpoint) in the **profile overlay** `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- id: sessions
  name: dsh-session-s3
  config:
    bucket: my-sessions
    region: us-west-2
    prefix: dsh/
    # endpoint: https://<account>.r2.cloudflarestorage.com   # R2 / MinIO / Tigris
```

Do **not** put access keys in the patch. See [AWS credentials](#aws-credentials).

Library helper (no DSH, not the seam):

```ts
import { createProvider } from "dsh-session-s3";

const persistence = createProvider({
  bucket: "my-sessions",
  region: "us-west-2",
});

await persistence.append("sess-1", { type: "user/message", text: "hi" });
const events = await persistence.read("sess-1");
await persistence.compact("sess-1", 10); // keep the last 10 fragments
await persistence.close("sess-1");
```

## AWS credentials

Resolution order (`parseConfig` → `createS3Client`):

1. Plugin config `accessKeyId` **and** `secretAccessKey` (both required if either is set) — static keys, no session token
2. Else **omit keys** and use the AWS SDK default chain (`AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` + `AWS_SESSION_TOKEN`, `~/.aws/credentials`, `AWS_PROFILE`, SSO, IAM instance/task role)

**Prefer (2) on real AWS.** `parseConfig` does not copy env keys into static credentials — that would drop `AWS_SESSION_TOKEN` and break SSO / assumed roles / GitHub OIDC. Leave `accessKeyId` / `secretAccessKey` unset in the Cordis patch.

### Local / laptop

```bash
aws configure
# or
aws sso login --profile myprofile
export AWS_PROFILE=myprofile
export AWS_REGION=us-west-2
# then set bucket in the profile overlay, not via a DSH_S3_* env
```

### IAM user / access keys (CI, MinIO, R2)

```bash
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...
# bucket still comes from the profile overlay `config.bucket`
```

Only set `accessKeyId` / `secretAccessKey` in plugin config when you cannot use env or the chain. Do not commit them.

### EC2 / ECS / Lambda

Attach an instance or task role. Do not set keys. The SDK picks up the role.

### IAM policy (minimum)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject"
      ],
      "Resource": "arn:aws:s3:::my-sessions/dsh/*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::my-sessions",
      "Condition": {
        "StringLike": { "s3:prefix": ["dsh/*"] }
      }
    }
  ]
}
```

`If-Match` / `If-None-Match` are request headers, not extra IAM actions. `list()` / `listSnapshots()` call `ListObjectsV2` and need `s3:ListBucket`.

### R2 / MinIO / Tigris

Same keys, plus `endpoint`. Path-style is on automatically when `endpoint` is set:

```bash
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
# set endpoint + bucket on the plugin config in the profile overlay
```

### Check CAS

```bash
aws s3api put-object --bucket my-sessions --key dsh/_probe --body /dev/null \
  --if-none-match '*'
```

A retry should 412. If it always 200s, the store is ignoring preconditions and this plugin is unsafe there.

## Object layout

```
s3://{bucket}/{prefix}sessions/{sessionId}/
├── manifest.json                 # CAS coordination point
└── fragments/00000001.jsonl      # immutable, SHA-256 in the manifest
```

Write path (`flush`):

1. GET `manifest.json`. If the tail already has this batch's SHA-256, treat it as a lost CAS response.
2. Buffer is serialized as a JSONL fragment (`seq = last + 1`). `PutObject` with `If-None-Match: *`. On 412, LIST occupied keys, take `seq = max(manifest+1, maxOccupied+1)`, retry.
3. Conditional PUT `manifest.json` with the ETag from step 1 (`If-Match`, quoted). Reload only after a 412. Idempotent on seq and tail sha256.
4. Drop only the snapshotted prefix of the buffer after CAS succeeds (events appended during the flush stay).

Uncontended single-writer flush is three S3 requests. A crash between (2) and (3) leaves an **orphan fragment**. Harmless: the manifest is source of truth.

The successful conditional PUT of `manifest.json` is the commit point. Fragment
sequence numbers order storage objects; they are not DSH event `seq` values.
CAS preserves every writer's bytes but does not allocate cross-process event
sequences. See [Design rationale](docs/design-rationale.md) for the precise
guarantees and remaining races.

## S3 compatibility

| Backend | If-Match / If-None-Match | Phase 1 |
| --- | --- | --- |
| AWS S3 | yes (quoted ETags) | intended; live IT env-gated |
| Cloudflare R2 | yes | intended |
| Tigris | yes | intended |
| MinIO | yes | intended; `S3_IT=1` against local MinIO |
| GCS (S3 interop) | weak / eventual on some paths | use with care |
| SeaweedFS | version-dependent | use with care |

CAS is the correctness mechanism. Do not point this at a store that silently ignores conditional puts.

Env-gated integration test (and the CI `MinIO integration` job):

```bash
S3_IT=1 S3_BUCKET=test S3_ENDPOINT=http://127.0.0.1:9000 \
  S3_REGION=us-east-1 \
  AWS_ACCESS_KEY_ID=minioadmin AWS_SECRET_ACCESS_KEY=minioadmin \
  npm test
```

## Caveats

1. **Same composition as JSONL.** `S3SessionPersistence` extends `@deepseek-ai/dsh-session-persistence`'s `SessionPersistence` and implements `PersistenceBackend`, then constructs `PersistenceCoordinator(ctx, this)`. Cold `load` therefore emits synthetic interrupted-turn closers; `instanceof SessionPersistence` is true. Peer deps (`cordis`, `dsh-session`, `dsh-session-persistence`) are provided by the DSH profile at install time.
2. **One live writer per session.** DSH does not support two processes concurrently writing the same `SessionId`. Manifest CAS is a **defensive** check: `appendBatch` revalidates `SessionEvent.seq` inside the CAS mutate and throws `StaleWriterError` instead of committing both batches. The loser's fragment PUT is an unreachable orphan. No leases, heartbeats, or fencing.
3. **No setsum** (deliberate, Phase 2). Integrity is per-fragment SHA-256 only.
4. **Response ambiguity is bounded, not exactly-once.** A fragment PUT can leave an orphan. A lost manifest response is recognized by matching the tail SHA-256 (library helper and DSH backend). Library fragments carry a nonce header so identical consecutive batches do not collapse.
5. **Library `createProvider()`** is a 5-method helper (`load`/`append`/`read`/`compact`/`close`) for non-DSH callers. It does **not** interpret `SessionEvent.seq`. Concurrent library flushes reallocate a stale fragment ordinal above the committed tail instead of appending out of order. DSH uses the default class export. **`read()` includes the in-memory buffer** (not yet on S3). `compact` / `close` flush first. `trim` refuses a session that already has a DSH header.
6. **Trim vs concurrent readers.** `trim` CAS-updates the manifest, then deletes dropped objects. A reader holding an old manifest that GETs a deleted fragment sees `FragmentCorruptError`. Phase 1 assumes one writer and no trim-during-read.
7. **Manifest rewrite is O(n) bytes per flush.** Each commit rewrites the whole fragment list, so bytes transferred grow O(n²) over an untrimmed session. Fine for Phase 1; compact long-lived logs.

## Roadmap

- Phase 2 — setsum / global log verification, verified GC
- Optional — binary fragments, DynamoDB Streams notifications

## Develop

```bash
npm install
npm test
npm run build
```

CI (`.github/workflows/ci.yml`) typechecks, runs the unit suite, then repeats the suite against MinIO with `S3_IT=1`.

`SPEC.md` is the Phase 1 contract.
