#!/usr/bin/env bash
# Per-boot startup: bring up a local MinIO (S3-compatible) store and create the
# integration-test bucket. Idempotent: no-op if MinIO is already healthy.
# Run the env-gated suite with:
#   S3_IT=1 S3_BUCKET=test S3_ENDPOINT=http://127.0.0.1:9000 S3_REGION=us-east-1 \
#     AWS_ACCESS_KEY_ID=minioadmin AWS_SECRET_ACCESS_KEY=minioadmin npm test
set -euo pipefail

cd "$(dirname "$0")/.."

MINIO_BIN="$HOME/.local/bin/minio"
DATA_DIR="$HOME/.minio/data"
LOG_FILE="$HOME/.minio/minio.log"
ENDPOINT="http://127.0.0.1:9000"

mkdir -p "$DATA_DIR" "$(dirname "$LOG_FILE")"

if curl -sf "$ENDPOINT/minio/health/live" >/dev/null 2>&1; then
  echo "MinIO already running"
else
  MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin \
    nohup "$MINIO_BIN" server "$DATA_DIR" \
    --address :9000 --console-address :9001 >"$LOG_FILE" 2>&1 &
  for _ in $(seq 1 30); do
    if curl -sf "$ENDPOINT/minio/health/live" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  if ! curl -sf "$ENDPOINT/minio/health/live" >/dev/null 2>&1; then
    echo "MinIO did not become ready" >&2
    cat "$LOG_FILE" >&2 || true
    exit 1
  fi
  echo "MinIO started"
fi

# Create the integration bucket (idempotent) via the repo's aws-sdk.
S3_REGION=us-east-1 S3_ENDPOINT="$ENDPOINT" S3_BUCKET=test \
AWS_ACCESS_KEY_ID=minioadmin AWS_SECRET_ACCESS_KEY=minioadmin \
node --input-type=module <<'NODE'
import { S3Client, CreateBucketCommand } from "@aws-sdk/client-s3";
const client = new S3Client({
  region: process.env.S3_REGION,
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});
try {
  await client.send(new CreateBucketCommand({ Bucket: process.env.S3_BUCKET }));
  console.log(`Created bucket ${process.env.S3_BUCKET}`);
} catch (error) {
  const name = error instanceof Error ? error.name : "";
  const status = error && error.$metadata ? error.$metadata.httpStatusCode : undefined;
  if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists" && status !== 409) {
    throw error;
  }
  console.log(`Bucket ${process.env.S3_BUCKET} already exists`);
}
NODE
