#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "Usage: $0 <cid-bot|johnny5-bot> <anthropic|ollama> [model]" >&2
  exit 1
fi

BOT="$1"
MODE="$2"
MODEL="${3:-}"

if [[ "${BOT}" != "cid-bot" && "${BOT}" != "johnny5-bot" ]]; then
  echo "Invalid bot: ${BOT}" >&2
  exit 1
fi

if [[ "${MODE}" != "anthropic" && "${MODE}" != "ollama" ]]; then
  echo "Invalid mode: ${MODE}" >&2
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

upsert_kv() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "${ENV_FILE}"; then
    sed "${SED_I[@]}" "s|^${key}=.*$|${key}=${value}|" "${ENV_FILE}"
  else
    printf '%s=%s\n' "${key}" "${value}" >> "${ENV_FILE}"
  fi
}

if [[ "${MODE}" == "anthropic" ]]; then
  MODEL="${MODEL:-claude-sonnet-4-5}"
  upsert_kv BRAIN_MODEL "${MODEL}"
  upsert_kv BRAIN_BASE_URL ""
  upsert_kv BRAIN_AUTH_TOKEN ""
  upsert_kv BRAIN_API_KEY ""
  echo "Set ${BOT} brain mode to anthropic"
  echo "BRAIN_MODEL=${MODEL}"
  echo "BRAIN_BASE_URL=(empty)"
  echo "BRAIN_AUTH_TOKEN=(empty)"
  echo "BRAIN_API_KEY=(empty)"
else
  MODEL="${MODEL:-devstral-small-2-fast:latest}"
  upsert_kv BRAIN_MODEL "${MODEL}"
  upsert_kv BRAIN_BASE_URL "http://host.containers.internal:11434"
  upsert_kv BRAIN_AUTH_TOKEN "ollama"
  upsert_kv BRAIN_API_KEY ""
  upsert_kv BRAIN_OAUTH_TOKEN ""
  echo "Set ${BOT} brain mode to ollama"
  echo "BRAIN_MODEL=${MODEL}"
  echo "BRAIN_BASE_URL=http://host.containers.internal:11434"
  echo "BRAIN_AUTH_TOKEN=ollama"
fi

echo
echo "Apply with:"
echo "  ./scripts/stop-bot.sh ${BOT} && ./scripts/start-bot.sh ${BOT}"
