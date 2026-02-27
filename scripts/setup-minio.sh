#!/usr/bin/env bash
# Start MinIO as a Podman container for InfiniClaw S3 sync.
# Run on the machine that hosts shared state (typically the primary/always-on machine).
set -euo pipefail

CONTAINER_NAME="minio"
DATA_DIR="${HOME}/minio-data"

# Stop existing if running
if podman container exists "$CONTAINER_NAME" 2>/dev/null; then
  echo "Stopping existing MinIO container..."
  podman stop "$CONTAINER_NAME" 2>/dev/null || true
  podman rm "$CONTAINER_NAME" 2>/dev/null || true
fi

mkdir -p "$DATA_DIR"

echo "Starting MinIO..."
podman run -d \
  --name "$CONTAINER_NAME" \
  --restart=always \
  -p 9000:9000 \
  -p 9001:9001 \
  -v "${DATA_DIR}:/data" \
  -e MINIO_ROOT_USER=minioadmin \
  -e MINIO_ROOT_PASSWORD=minioadmin \
  quay.io/minio/minio server /data --console-address ":9001"

echo ""
echo "MinIO running:"
echo "  API:     http://localhost:9000"
echo "  Console: http://localhost:9001"
echo "  Credentials: minioadmin / minioadmin"
echo ""
echo "Create the infiniclaw bucket:"
echo "  podman exec minio mc alias set local http://localhost:9000 minioadmin minioadmin"
echo "  podman exec minio mc mb local/infiniclaw"
