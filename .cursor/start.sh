#!/usr/bin/env bash
# Per-boot service: run a local MinIO (S3-compatible) store on :9000 for the
# env-gated S3 integration suite (S3_IT=1). MinIO runs in the FOREGROUND (exec)
# so the platform supervises it and keeps it alive for the agent's lifetime.
# The integration bucket is created in the background once MinIO is healthy.
#
# Run the env-gated suite once this is up:
#   S3_IT=1 S3_BUCKET=test S3_ENDPOINT=http://127.0.0.1:9000 S3_REGION=us-east-1 \
#     AWS_ACCESS_KEY_ID=minioadmin AWS_SECRET_ACCESS_KEY=minioadmin npm test
set -euo pipefail

cd "$(dirname "$0")/.."

MINIO_BIN="$HOME/.local/bin/minio"
DATA_DIR="$HOME/.minio/data"
ENDPOINT="http://127.0.0.1:9000"

mkdir -p "$DATA_DIR"

# Create the integration bucket once MinIO answers health. Runs in the
# background so it does not block the foreground server below.
(
  for _ in $(seq 1 60); do
    if curl -sf "$ENDPOINT/minio/health/live" >/dev/null 2>&1; then
      S3_ENDPOINT="$ENDPOINT" node ./.cursor/create-bucket.mjs || true
      break
    fi
    sleep 1
  done
) &

exec env MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin \
  "$MINIO_BIN" server "$DATA_DIR" --address :9000 --console-address :9001
