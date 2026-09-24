#!/usr/bin/env bash
# Idempotent repository bootstrap for dsh-session-s3.
# Installs node dependencies and fetches the MinIO binary used by the
# env-gated integration suite (Docker is not available in Cloud Agent VMs).
# Bring MinIO up on demand with ./.cursor/minio-up.sh before running S3_IT=1 tests.
set -euo pipefail

cd "$(dirname "$0")/.."

npm ci

# dl.min.io no longer serves the community binary (returns HTTP 410), so pull the
# pinned release asset from GitHub instead. Keep this in sync with the RELEASE tag
# used by the CI "MinIO integration" job.
MINIO_RELEASE="RELEASE.2025-09-07T16-13-09Z"
MINIO_BIN="$HOME/.local/bin/minio"
if [ ! -x "$MINIO_BIN" ]; then
  mkdir -p "$(dirname "$MINIO_BIN")"
  curl -sSfL -o "$MINIO_BIN" \
    "https://github.com/minio/minio/releases/download/${MINIO_RELEASE}/minio.linux-amd64.${MINIO_RELEASE}"
  chmod +x "$MINIO_BIN"
fi
