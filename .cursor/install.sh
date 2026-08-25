#!/usr/bin/env bash
# Idempotent repository bootstrap for Cloud Agents.
# Installs Node dependencies and the MinIO server binary used by the
# env-gated S3 integration suite (S3_IT=1). Runs after checkout; safe to rerun.
set -euo pipefail

cd "$(dirname "$0")/.."

npm ci

# Pin the same MinIO RELEASE the CI integration job uses.
MINIO_RELEASE="RELEASE.2025-09-07T16-13-09Z"
MINIO_BIN="$HOME/.local/bin/minio"
mkdir -p "$(dirname "$MINIO_BIN")"

if [ -x "$MINIO_BIN" ] && "$MINIO_BIN" --version 2>/dev/null | grep -q "$MINIO_RELEASE"; then
  echo "MinIO $MINIO_RELEASE already installed"
else
  curl -sSfL -o "$MINIO_BIN" \
    "https://dl.min.io/server/minio/release/linux-amd64/archive/minio.${MINIO_RELEASE}"
  chmod +x "$MINIO_BIN"
  echo "Installed MinIO $MINIO_RELEASE"
fi
