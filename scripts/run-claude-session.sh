#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <cid-bot|johnny5-bot> [claude args...]" >&2
  exit 1
fi

BOT="$1"
shift || true

if [[ "${BOT}" != "cid-bot" && "${BOT}" != "johnny5-bot" ]]; then
  echo "Invalid bot: ${BOT}" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/common.sh"

required_cmd podman
required_cmd rsync

INSTANCE_DIR="$(instance_dir "${BOT}")"
if [[ ! -d "${INSTANCE_DIR}" ]]; then
  echo "Missing instance for ${BOT}. Run scripts/setup.sh first." >&2
  exit 1
fi

load_profile_env "${BOT}"
apply_brain_env
ensure_podman_ready

IMAGE="${CONTAINER_IMAGE:-nanoclaw-agent:latest}"
if ! podman image exists "${IMAGE}" >/dev/null 2>&1; then
  echo "Missing Podman image: ${IMAGE}" >&2
  echo "Build it with: (cd ${INSTANCE_DIR}/container && ./build.sh)" >&2
  exit 1
fi

GROUP_DIR="${INSTANCE_DIR}/groups/main"
GLOBAL_DIR="${INSTANCE_DIR}/groups/global"
SESSIONS_DIR="${DATA_DIR}/sessions/${BOT}/main/.claude"
CACHE_DIR="${DATA_DIR}/cache/${BOT}/main"

mkdir -p "${GROUP_DIR}" "${SESSIONS_DIR}" "${CACHE_DIR}"

HOST_CLAUDE_DIR="${HOME}/.claude"
if [[ -d "${HOST_CLAUDE_DIR}" ]]; then
  rsync -a \
    --exclude debug \
    --exclude projects \
    --exclude todos \
    --exclude telemetry \
    --exclude shell-snapshots \
    --exclude history.jsonl \
    "${HOST_CLAUDE_DIR}/" "${SESSIONS_DIR}/"
fi

GROUP_CLAUDE_MD="${GROUP_DIR}/CLAUDE.md"
PROFILE_CLAUDE_MD="${ROOT_DIR}/profiles/${BOT}/CLAUDE.md"
if [[ ! -f "${GROUP_CLAUDE_MD}" ]]; then
  if [[ -f "${PROFILE_CLAUDE_MD}" ]]; then
    cp "${PROFILE_CLAUDE_MD}" "${GROUP_CLAUDE_MD}"
  elif [[ "${BOT}" == "cid-bot" && -f "${BASE_NANOCLAW_DIR}/CID.md" ]]; then
    cp "${BASE_NANOCLAW_DIR}/CID.md" "${GROUP_CLAUDE_MD}"
  fi
fi

SETTINGS_FILE="${SESSIONS_DIR}/settings.json"
if [[ ! -f "${SETTINGS_FILE}" ]]; then
  cat > "${SETTINGS_FILE}" <<'JSON'
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1",
    "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD": "1",
    "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "0"
  }
}
JSON
fi

TMP_ENV="$(mktemp /tmp/infiniclaw-claude-env.XXXXXX)"
cleanup() {
  rm -f "${TMP_ENV}"
}
trap cleanup EXIT

validate_brain_env

for key in \
  ANTHROPIC_MODEL \
  ANTHROPIC_BASE_URL \
  ANTHROPIC_AUTH_TOKEN \
  ANTHROPIC_API_KEY \
  CLAUDE_CODE_OAUTH_TOKEN \
  OLLAMA_HOST \
  OPENAI_API_KEY \
  OPENAI_BASE_URL; do
  write_env_if_set "${TMP_ENV}" "${key}"
done

HOST_CERT_FILE="${BRAIN_CA_CERT_FILE:-}"
if [[ -z "${HOST_CERT_FILE}" && -f "${HOME}/.ssh/corporate-certs.pem" ]]; then
  HOST_CERT_FILE="${HOME}/.ssh/corporate-certs.pem"
fi

CONTAINER_CERT_FILE="/workspace/host-certs/corporate-certs.pem"
if [[ -n "${HOST_CERT_FILE}" ]]; then
  if [[ ! -f "${HOST_CERT_FILE}" ]]; then
    echo "Configured BRAIN_CA_CERT_FILE does not exist: ${HOST_CERT_FILE}" >&2
    exit 1
  fi
  printf 'SSL_CERT_FILE=%s\n' "${CONTAINER_CERT_FILE}" >> "${TMP_ENV}"
  printf 'NODE_EXTRA_CA_CERTS=%s\n' "${CONTAINER_CERT_FILE}" >> "${TMP_ENV}"
  printf 'REQUESTS_CA_BUNDLE=%s\n' "${CONTAINER_CERT_FILE}" >> "${TMP_ENV}"
  printf 'CURL_CA_BUNDLE=%s\n' "${CONTAINER_CERT_FILE}" >> "${TMP_ENV}"
  printf 'GIT_SSL_CAINFO=%s\n' "${CONTAINER_CERT_FILE}" >> "${TMP_ENV}"
fi

echo "Starting Claude Code session for ${BOT}"
echo "Image: ${IMAGE}"

ARGS=(
  run
  --rm
  -it
  --pull=never
  --name "nanoclaw-shell-${BOT}-$(date +%s)"
  --env-file "${TMP_ENV}"
  -v "${INSTANCE_DIR}:/workspace/project"
  -v "${GROUP_DIR}:/workspace/group"
  -v "${SESSIONS_DIR}:/home/node/.claude"
  -v "${CACHE_DIR}:/workspace/cache"
  -w /workspace/group
  --entrypoint claude
)

if [[ -d "${GLOBAL_DIR}" ]]; then
  ARGS+=( -v "${GLOBAL_DIR}:/workspace/global:ro" )
fi

if [[ -d "${HOME}/.codex" ]]; then
  ARGS+=( -v "${HOME}/.codex:/home/node/.codex" )
fi

if [[ -d "${HOME}/.gemini" ]]; then
  ARGS+=( -v "${HOME}/.gemini:/home/node/.gemini" )
fi

if [[ -n "${HOST_CERT_FILE}" ]]; then
  ARGS+=( -v "${HOST_CERT_FILE}:${CONTAINER_CERT_FILE}:ro" )
fi

ARGS+=( "${IMAGE}" --dangerously-skip-permissions )

if [[ -n "${ANTHROPIC_MODEL:-}" ]]; then
  ARGS+=( --model "${ANTHROPIC_MODEL}" )
fi

if [[ $# -gt 0 ]]; then
  ARGS+=( "$@" )
fi

exec podman "${ARGS[@]}"
