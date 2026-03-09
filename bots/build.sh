#!/usr/bin/env bash
# Build agent container images.
# Usage: ./bots/build.sh [bot-name|all]
# Discovers bots by finding Dockerfiles under bots/<role>/<bot>/Dockerfile.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONTAINER_CONTEXT="${SCRIPT_DIR}/container"

if ! command -v podman >/dev/null 2>&1; then
  echo "podman not found in PATH" >&2
  exit 1
fi

# Discover all bots that have a Dockerfile
discover_bots() {
  find "${SCRIPT_DIR}" -mindepth 3 -maxdepth 3 -name Dockerfile | while read -r df; do
    basename "$(dirname "$df")"
  done | sort
}

build_image() {
  local bot="$1"
  local image_name="nanoclaw-${bot}:latest"
  local dockerfile
  dockerfile=$(find "${SCRIPT_DIR}" -mindepth 3 -maxdepth 3 -name Dockerfile -path "*/${bot}/Dockerfile" | head -1)

  if [[ -z "${dockerfile}" ]]; then
    echo "Dockerfile not found for bot: ${bot}" >&2
    return 1
  fi

  echo "Building ${image_name} (${dockerfile#"${ROOT_DIR}/"})"
  podman build --network host -t "${image_name}" -f "${dockerfile}" "${CONTAINER_CONTEXT}"
  echo "${image_name}: done"
}

target="${1:-all}"
if [[ "${target}" == "all" ]]; then
  for bot in $(discover_bots); do
    build_image "$bot"
  done
else
  build_image "$target"
fi
