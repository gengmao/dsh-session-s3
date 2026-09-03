#!/usr/bin/env bash
# On-demand MinIO helper for dsh-session-s3.
# Starts a local MinIO (S3-compatible, supports If-Match/If-None-Match CAS) and
# creates the integration-test bucket so the env-gated suite (S3_IT=1) can run
# without Docker. Idempotent: safe to run repeatedly. Run this before:
#   S3_IT=1 S3_BUCKET=test S3_ENDPOINT=http://127.0.0.1:9000 S3_REGION=us-east-1 \
#     AWS_ACCESS_KEY_ID=minioadmin AWS_SECRET_ACCESS_KEY=minioadmin npm test
set -euo pipefail

MINIO_BIN="$HOME/.local/bin/minio"
DATA_DIR="$HOME/.minio-data"
LOG_FILE="$HOME/.minio.log"
ENDPOINT="http://127.0.0.1:9000"
BUCKET="test"
export MINIO_ROOT_USER="${MINIO_ROOT_USER:-minioadmin}"
export MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-minioadmin}"

if [ ! -x "$MINIO_BIN" ]; then
  echo "MinIO binary missing at $MINIO_BIN; skipping (integration tests will remain skipped)." >&2
  exit 0
fi

mkdir -p "$DATA_DIR"

if ! curl -sf "$ENDPOINT/minio/health/live" >/dev/null 2>&1; then
  nohup "$MINIO_BIN" server "$DATA_DIR" --address :9000 --console-address :9001 \
    >"$LOG_FILE" 2>&1 &
  for _ in $(seq 1 30); do
    if curl -sf "$ENDPOINT/minio/health/live" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi

if ! curl -sf "$ENDPOINT/minio/health/live" >/dev/null 2>&1; then
  echo "MinIO did not become ready; see $LOG_FILE" >&2
  exit 1
fi

# Create the integration-test bucket (idempotent) using the AWS SDK already in node_modules.
cd "$(dirname "$0")/.."
AWS_ACCESS_KEY_ID="$MINIO_ROOT_USER" AWS_SECRET_ACCESS_KEY="$MINIO_ROOT_PASSWORD" \
S3_ENDPOINT="$ENDPOINT" S3_REGION="us-east-1" S3_BUCKET="$BUCKET" \
node --input-type=module <<'EOF'
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
} catch (error) {
  const name = error instanceof Error ? error.name : "";
  const status = error && error.$metadata ? error.$metadata.httpStatusCode : undefined;
  if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists" && status !== 409) {
    throw error;
  }
}
EOF

echo "MinIO ready at $ENDPOINT (bucket: $BUCKET)."
