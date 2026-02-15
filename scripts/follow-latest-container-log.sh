#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: $0 <cid-bot|johnny5-bot> [group-folder]" >&2
  exit 1
fi

BOT="$1"
GROUP_FOLDER="${2:-main}"

if [[ "${BOT}" != "cid-bot" && "${BOT}" != "johnny5-bot" ]]; then
  echo "Invalid bot: ${BOT}" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/common.sh"

LOG_DIR="$(instance_dir "${BOT}")/groups/${GROUP_FOLDER}/logs"
mkdir -p "${LOG_DIR}"

echo "Watching latest container log in: ${LOG_DIR}"
echo "Press Ctrl-C to stop."
echo

CURRENT=""
while true; do
  LATEST="$(ls -1t "${LOG_DIR}"/container-*.log 2>/dev/null | head -n1 || true)"
  if [[ -z "${LATEST}" ]]; then
    echo "No container logs yet for ${BOT}/${GROUP_FOLDER}..."
    sleep 2
    continue
  fi

  if [[ "${LATEST}" != "${CURRENT}" ]]; then
    CURRENT="${LATEST}"
    echo
    echo "=== Following ${CURRENT} ==="
    echo
  fi

  # Re-evaluate every few seconds so we can switch to a newer container log.
  timeout 5s tail -n 120 -F "${CURRENT}" || true
done
