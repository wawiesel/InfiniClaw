#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <cid-bot|johnny5-bot>" >&2
  exit 1
fi

BOT="$1"
if [[ "${BOT}" != "cid-bot" && "${BOT}" != "johnny5-bot" ]]; then
  echo "Invalid bot: ${BOT}" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/common.sh"

PID_FILE="$(pid_path "${BOT}")"
if [[ ! -f "${PID_FILE}" ]]; then
  echo "${BOT} is not running (no pid file)"
  exit 0
fi

PID="$(cat "${PID_FILE}")"
if kill -0 "${PID}" >/dev/null 2>&1; then
  kill "${PID}" || true
  sleep 1
  if kill -0 "${PID}" >/dev/null 2>&1; then
    kill -9 "${PID}" || true
  fi
fi

rm -f "${PID_FILE}"
echo "Stopped ${BOT}"

