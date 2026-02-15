#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "Usage: $0 <cid-bot|johnny5-bot> <model> [base_url]" >&2
  exit 1
fi

BOT="$1"
MODEL="$2"
BASE_URL="${3:-}"

if [[ "${BOT}" != "cid-bot" && "${BOT}" != "johnny5-bot" ]]; then
  echo "Invalid bot: ${BOT}" >&2
  echo "Expected one of: cid-bot, johnny5-bot" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/common.sh"

ENV_FILE="$(profile_env_path "${BOT}")"
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing profile env: ${ENV_FILE}" >&2
  echo "Copy from: $(profile_env_example_path "${BOT}")" >&2
  exit 1
fi

if [[ "$(uname -s)" == "Darwin" ]]; then
  SED_I=(-i '')
else
  SED_I=(-i)
fi

if grep -q '^BRAIN_MODEL=' "${ENV_FILE}"; then
  sed "${SED_I[@]}" "s|^BRAIN_MODEL=.*$|BRAIN_MODEL=${MODEL}|" "${ENV_FILE}"
else
  printf '\nBRAIN_MODEL=%s\n' "${MODEL}" >> "${ENV_FILE}"
fi

if [[ -n "${BASE_URL}" ]]; then
  if grep -q '^BRAIN_BASE_URL=' "${ENV_FILE}"; then
    sed "${SED_I[@]}" "s|^BRAIN_BASE_URL=.*$|BRAIN_BASE_URL=${BASE_URL}|" "${ENV_FILE}"
  else
    printf 'BRAIN_BASE_URL=%s\n' "${BASE_URL}" >> "${ENV_FILE}"
  fi
fi

echo "Updated ${ENV_FILE}"
echo "BRAIN_MODEL=${MODEL}"
if [[ -n "${BASE_URL}" ]]; then
  echo "BRAIN_BASE_URL=${BASE_URL}"
fi
echo
echo "Apply with:"
echo "  ./scripts/stop-bot.sh ${BOT} && ./scripts/start-bot.sh ${BOT}"
