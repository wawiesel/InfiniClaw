#!/usr/bin/env bash
# Build the NanoClaw agent container image using the configured runtime.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

TAG="${1:-latest}"
RUNTIME="${CONTAINER_RUNTIME:-podman}"
DEFAULT_IMAGE="nanoclaw-agent:${TAG}"
IMAGE_REF="${CONTAINER_IMAGE:-$DEFAULT_IMAGE}"

echo "Building NanoClaw agent container image..."
echo "Runtime: ${RUNTIME}"
echo "Image:   ${IMAGE_REF}"

if [[ "${RUNTIME}" == "podman" ]]; then
  if ! command -v podman >/dev/null 2>&1; then
    echo "podman not found in PATH" >&2
    exit 1
  fi
  # Best effort preflight for local VM runtime.
  podman machine list >/dev/null 2>&1 || true
  podman info >/dev/null 2>&1 || true
  podman build -t "${IMAGE_REF}" -f Dockerfile .
  echo ""
  echo "Build complete!"
  echo "Image: ${IMAGE_REF}"
  echo ""
  echo "Preflight:"
  echo "  podman machine list"
  echo "  podman info"
  echo "  podman image exists ${IMAGE_REF}"
  echo ""
  echo "Test with:"
  echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | podman run -i ${IMAGE_REF}"
  exit 0
fi

if [[ "${RUNTIME}" == "container" ]]; then
  if ! command -v container >/dev/null 2>&1; then
    echo "container not found in PATH" >&2
    exit 1
  fi
  container build -t "${IMAGE_REF}" .
  echo ""
  echo "Build complete!"
  echo "Image: ${IMAGE_REF}"
  echo ""
  echo "Test with:"
  echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | container run -i ${IMAGE_REF}"
  exit 0
fi

echo "Unsupported CONTAINER_RUNTIME=${RUNTIME}. Use podman or container." >&2
exit 1
