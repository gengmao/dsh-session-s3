# dsh-session-s3

Unofficial community [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin: an S3-backed **SessionPersistence** provider.

wal3-Lite: **immutable JSONL fragments** + a **CAS manifest** (`If-None-Match` / `If-Match`). Per-fragment SHA-256. No setsum in Phase 1.

Fixes the class of JSONL durability bugs that come from torn writes, missing fsync, and concurrent writers — by never mutating a fragment and coordinating writers on a single compare-and-swap object.

The 7 field-confirmed DSH corruption discussions ([#1333](https://github.com/deepseek-ai/deepseek-harness/discussions/1333), [#1452](https://github.com/deepseek-ai/deepseek-harness/discussions/1452), [#1497](https://github.com/deepseek-ai/deepseek-harness/discussions/1497), [#1473](https://github.com/deepseek-ai/deepseek-harness/discussions/1473), [#1586](https://github.com/deepseek-ai/deepseek-harness/discussions/1586), [#2167](https://github.com/deepseek-ai/deepseek-harness/discussions/2167), [#2342](https://github.com/deepseek-ai/deepseek-harness/discussions/2342)) are encoded as tests in `test/corruption-scenarios.test.ts`. Results: [docs/corruption-scenarios.md](docs/corruption-scenarios.md).

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

Requires Node >= 18.

## Config

| Key | Default | Notes |
| --- | --- | --- |
| `bucket` | *(required)* | S3 bucket |
| `prefix` | `dsh/` | Keys live at `{prefix}sessions/{sessionId}/` |
| `region` | `auto` | AWS region, or `auto` for R2 |
| `endpoint` | — | R2 / Tigris / MinIO / SeaweedFS / GCS interop (must be `http(s)`) |
| `forcePathStyle` | `true` when `endpoint` is set | Path-style URLs |
| `accessKeyId` / `secretAccessKey` | unset | Only for static keys. Prefer the SDK default chain (see below) |
| `flushThresholdEvents` | `50` | Flush the in-memory buffer after N events |
| `flushThresholdBytes` | `262144` | …or after 256 KiB |
| `preparedSessionCacheSize` | coordinator default (5) | LRU of unpublished preparations |
| `writeBatchMaxDelayMs` | coordinator default (200) | Write-behind delay |

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
await persistence.compact("sess-1", 10);
await persistence.close("sess-1");
```

## AWS credentials

Resolution order (`parseConfig` → `createS3Client`):

1. Plugin config `accessKeyId` **and** `secretAccessKey` (both required if either is set)
2. Else `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` at load time
3. Else **omit keys** and use the AWS SDK default chain (`~/.aws/credentials`, `AWS_PROFILE`, SSO, IAM instance/task role)

**Prefer (3) on real AWS.** Passing static keys skips `AWS_SESSION_TOKEN`, so SSO and assumed-role creds fail. Leave `accessKeyId` / `secretAccessKey` unset in the Cordis patch.

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
├── fragments/00000001.jsonl      # immutable, SHA-256 in the manifest
└── checkpoints/cp-00000001.json
```

Write path (`flush`):

1. Buffer is serialized as a JSONL fragment (`seq = last + 1`).
2. `PutObject` with `If-None-Match: *` and a **quoted** ETag on later `If-Match`. On 412, reload the manifest, take `seq = max(manifest+1, seq+1)`, retry.
3. CAS-update `manifest.json` (`If-Match`) to append the fragment ref (idempotent on seq and tail sha256).
4. Drop only the snapshotted prefix of the buffer after CAS succeeds (events appended during the flush stay).

A crash between (2) and (3) leaves an **orphan fragment**. Harmless: the manifest is source of truth, and the next flush advances past occupied seqs (`max(manifest+1, seq+1)`).

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

Env-gated integration test:

```bash
S3_IT=1 S3_BUCKET=test S3_ENDPOINT=http://127.0.0.1:9000 \
  AWS_ACCESS_KEY_ID=minioadmin AWS_SECRET_ACCESS_KEY=minioadmin \
  npm test
```

## Caveats

1. **Same composition as JSONL.** `S3SessionPersistence` extends `@deepseek-ai/dsh-session-persistence`'s `SessionPersistence` and implements `PersistenceBackend`, then constructs `PersistenceCoordinator(ctx, this)`. Cold `load` therefore emits synthetic interrupted-turn closers; `instanceof SessionPersistence` is true. Peer deps (`cordis`, `dsh-session`, `dsh-session-persistence`) are provided by the DSH profile at install time.
2. **No setsum** (deliberate, Phase 2). Integrity is per-fragment SHA-256 only.
3. **At-least-once fragments.** If a manifest CAS succeeds on the server but the response is lost, a retry may write a second fragment. The CAS mutate is idempotent on fragment seq and on the tail sha256.
4. **Library `createProvider()`** is a 5-method helper (`load`/`append`/`read`/`compact`/`close`) for non-DSH callers. DSH uses the default class export.
5. **Trim vs concurrent readers.** `trim` CAS-updates the manifest, then deletes dropped objects. A reader holding an old manifest that GETs a deleted fragment sees `FragmentCorruptError`. Phase 1 assumes one writer and no trim-during-read.

## Roadmap

- Phase 2 — setsum / global log verification, verified GC
- Optional — binary fragments, DynamoDB Streams notifications

## Develop

```bash
npm install
npm test
npm run build
```

`SPEC.md` is the Phase 1 contract.
