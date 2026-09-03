#!/usr/bin/env bash
# Idempotent repository bootstrap for dsh-session-s3.
# Installs node dependencies and fetches the MinIO binary used by the
# env-gated integration suite (Docker is not available in Cloud Agent VMs).
# Bring MinIO up on demand with ./.cursor/minio-up.sh before running S3_IT=1 tests.
set -euo pipefail

cd "$(dirname "$0")/.."

npm ci

MINIO_BIN="$HOME/.local/bin/minio"
if [ ! -x "$MINIO_BIN" ]; then
  mkdir -p "$(dirname "$MINIO_BIN")"
  curl -sSfL -o "$MINIO_BIN" \
    https://dl.min.io/server/minio/release/linux-amd64/minio
  chmod +x "$MINIO_BIN"
fi
