#!/usr/bin/env bash
# Build agent container images for both bots.
# Usage: ./container/build.sh [engineer|commander|all]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
NANOCLAW_CONTAINER="${ROOT_DIR}/nanoclaw/container"

if ! command -v podman >/dev/null 2>&1; then
  echo "podman not found in PATH" >&2
  exit 1
fi

build_image() {
  local bot="$1"
  local image_name="nanoclaw-${bot}:latest"
  local dockerfile="${SCRIPT_DIR}/${bot}/Dockerfile"

  if [[ ! -f "${dockerfile}" ]]; then
    echo "Dockerfile not found: ${dockerfile}" >&2
    return 1
  fi

  echo "Building ${image_name}..."
  # Build context is nanoclaw/container/ so COPY agent-runner/ works
  podman build -t "${image_name}" -f "${dockerfile}" "${NANOCLAW_CONTAINER}"
  echo "${image_name}: done"
}

target="${1:-all}"
case "${target}" in
  engineer)   build_image engineer ;;
  commander)  build_image commander ;;
  all)        build_image engineer && build_image commander ;;
  *)          echo "Usage: $0 [engineer|commander|all]" >&2; exit 1 ;;
esac
