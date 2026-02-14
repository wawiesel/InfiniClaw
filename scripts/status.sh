#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/common.sh"

for BOT in cid-bot johnny5-bot; do
  PID_FILE="$(pid_path "${BOT}")"
  if [[ -f "${PID_FILE}" ]]; then
    PID="$(cat "${PID_FILE}")"
    if kill -0 "${PID}" >/dev/null 2>&1; then
      echo "${BOT}: running (pid ${PID})"
    else
      echo "${BOT}: stale pid file (${PID})"
    fi
  else
    echo "${BOT}: stopped"
  fi
done

