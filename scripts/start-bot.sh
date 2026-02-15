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

required_cmd npm

INSTANCE_DIR="$(instance_dir "${BOT}")"
if [[ ! -d "${INSTANCE_DIR}" ]]; then
  echo "Missing instance for ${BOT}. Run scripts/setup.sh first." >&2
  exit 1
fi

PID_FILE="$(pid_path "${BOT}")"
LOG_FILE="$(log_path "${BOT}")"

if [[ -f "${PID_FILE}" ]]; then
  EXISTING_PID="$(cat "${PID_FILE}")"
  if kill -0 "${EXISTING_PID}" >/dev/null 2>&1; then
    echo "${BOT} already running (pid ${EXISTING_PID})"
    exit 0
  fi
  rm -f "${PID_FILE}"
fi

load_profile_env "${BOT}"
apply_brain_env

mkdir -p "${LOG_DIR}" "${RUN_DIR}"
touch "${LOG_FILE}"

(
  cd "${INSTANCE_DIR}"
  nohup npm run dev >>"${LOG_FILE}" 2>&1 &
  echo $! > "${PID_FILE}"
)

echo "Started ${BOT} (pid $(cat "${PID_FILE}"))"
echo "Log: ${LOG_FILE}"
echo "Brain model: ${ANTHROPIC_MODEL:-<unset>}"
echo "Brain base URL: ${ANTHROPIC_BASE_URL:-<default>}"
