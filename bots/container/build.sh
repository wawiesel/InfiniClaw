#!/usr/bin/env bash
# Build agent container images.
# Usage: ./container/build.sh [nora|johnny5|cid|parker|albert|all]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
NANOCLAW_CONTAINER="${ROOT_DIR}/external/nanoclaw/container"

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
  podman build --network host -t "${image_name}" -f "${dockerfile}" "${NANOCLAW_CONTAINER}"
  echo "${image_name}: done"
}

target="${1:-all}"
case "${target}" in
  nora)     build_image nora ;;
  johnny5)  build_image johnny5 ;;
  cid)      build_image cid ;;
  parker)   build_image parker ;;
  albert)   build_image albert ;;
  max)      build_image max ;;
  all)      build_image nora && build_image johnny5 && build_image cid && build_image parker && build_image albert && build_image max ;;
  *)        echo "Usage: $0 [nora|johnny5|cid|parker|albert|max|all]" >&2; exit 1 ;;
esac
