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
required_cmd podman
required_cmd rsync

INSTANCE_DIR="$(instance_dir "${BOT}")"
if [[ ! -d "${INSTANCE_DIR}" ]]; then
  echo "Missing instance for ${BOT}. Run scripts/setup.sh first." >&2
  exit 1
fi

# Keep bot instance code in sync with vendored nanoclaw before launching chat.
rsync -a --delete \
  --exclude node_modules \
  --exclude data \
  --exclude store \
  --exclude groups \
  --exclude logs \
  "${BASE_NANOCLAW_DIR}/" "${INSTANCE_DIR}/"

load_profile_env "${BOT}"
apply_brain_env
if [[ -z "${LOCAL_CHAT_SENDER_NAME:-}" ]]; then
  echo "Missing LOCAL_CHAT_SENDER_NAME in profiles/${BOT}/env" >&2
  exit 1
fi
if [[ -z "${LOCAL_MIRROR_MATRIX_JID:-}" ]]; then
  echo "Missing LOCAL_MIRROR_MATRIX_JID in profiles/${BOT}/env" >&2
  exit 1
fi
export INFINICLAW_ROOT="${ROOT_DIR}"
export LOCAL_CHANNEL_ENABLED=1
export LOCAL_CHAT_JID="${LOCAL_MIRROR_MATRIX_JID}"
if [[ "${BOT}" == "cid-bot" ]]; then
  export LOCAL_CHAT_NAME="Engineering (Terminal)"
else
  export LOCAL_CHAT_NAME="Bridge (Terminal)"
fi

ensure_podman_ready

cd "${INSTANCE_DIR}"
exec npm run dev
