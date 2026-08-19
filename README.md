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
| `endpoint` | — | R2 / Tigris / MinIO / SeaweedFS / GCS interop |
| `forcePathStyle` | `true` when `endpoint` is set | Path-style URLs |
| `accessKeyId` / `secretAccessKey` | unset | Only for static keys. Prefer the SDK default chain (see below) |
| `flushThresholdEvents` | `50` | Flush the in-memory buffer after N events |
| `flushThresholdBytes` | `262144` | …or after 256 KiB |

Invalid config **fails loud at load**, listing every problem (not just the first).

After install, set the bucket (and optional endpoint) in the **profile overlay** `$DSH_HOME/profiles/web/cordis.patch.yml`. The bundle patch already replaces the `sessions` row; override values there or in the profile layer that follows:

```yaml
- id: sessions
  name: dsh-session-s3
  config:
    bucket: my-sessions
    region: us-west-2
    prefix: dsh/
    # endpoint: https://<account>.r2.cloudflarestorage.com   # R2 / MinIO / Tigris
```

Or via env, which `cordis.patch.yml` in this repo reads:

| Env | Maps to |
| --- | --- |
| `DSH_S3_BUCKET` | `bucket` (required) |
| `DSH_S3_PREFIX` | `prefix` (default `dsh/`) |
| `DSH_S3_REGION` | `region` (default `auto`) |
| `DSH_S3_ENDPOINT` | `endpoint` (also turns on path-style) |

Do **not** put access keys in the patch. See [AWS credentials](#aws-credentials).

Programmatic use (no DSH):

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
export DSH_S3_BUCKET=my-sessions
```

### IAM user / access keys (CI, MinIO, R2)

```bash
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...
export DSH_S3_BUCKET=my-sessions
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
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::my-sessions/dsh/*"
    }
  ]
}
```

`If-Match` / `If-None-Match` are request headers, not extra IAM actions. `s3:ListBucket` is not required today.

### R2 / MinIO / Tigris

Same keys, plus `endpoint`. Path-style is on automatically when `endpoint` is set:

```bash
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export DSH_S3_BUCKET=my-sessions
export DSH_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
export DSH_S3_REGION=auto
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
2. `PutObject` with `If-None-Match: *`. On 412, reload the manifest, skip the orphan seq, retry.
3. CAS-update `manifest.json` (`If-Match`) to append the fragment ref.
4. Clear the buffer only after the CAS succeeds.

A crash between (2) and (3) leaves an **orphan fragment**. Harmless: the manifest is source of truth, and the next flush skips that seq.

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

1. **DSH seam.** `SessionPersistenceProvider` here is `load` / `append` / `read` / `compact` / `close`. Upstream `SessionPersistence` (`@deepseek-ai/dsh-session-persistence`) is a Cordis `Service` with `locate` / `create` / `prepare` / `inspect` / `readFrom` / `list` / `listSnapshots`. Reconcile against the real interface before using this as a drop-in for `dsh-session-persistence-jsonl`.
2. **No setsum** (deliberate, Phase 2). Integrity is per-fragment SHA-256 only.
3. **Payload `seq`.** This plugin stores opaque events. Colliding coordinator-assigned `SessionEvent.seq` values remain detectable but not fatal (see [docs/corruption-scenarios.md](docs/corruption-scenarios.md)).
4. **At-least-once fragments.** If a manifest CAS succeeds on the server but the response is lost, a retry may write a second fragment. The CAS mutate is idempotent on fragment seq and on the tail sha256; a lost response after a *fragment* PUT (orphan) is skipped. A lost response after CAS still cannot invent a new seq for the same bytes.
5. **`read()` includes the in-memory buffer** (not yet durable). `compact()` / `close()` flush first. Call `close` (or wait for a threshold flush) before treating `read()` as durable.
6. **Trim vs concurrent readers.** `trim` CAS-updates the manifest, then deletes dropped objects. A reader holding an old manifest that GETs a deleted fragment sees `FragmentCorruptError` — indistinguishable from bitrot. Phase 1 assumes one writer and no trim-during-read.
7. **Single-writer per session.** Two `S3SessionLog` instances on the same session id coordinate via CAS, but `trim` and `checkpoint` are not designed for concurrent readers.

## Roadmap

- Wire the real upstream `SessionPersistence` seam + reject appends whose first seq ≠ stored next-seq
- Phase 2 — setsum / global log verification, verified GC
- Optional — binary fragments, DynamoDB Streams notifications

## Develop

```bash
npm install
npm test
npm run build
```

`SPEC.md` is the Phase 1 contract.
