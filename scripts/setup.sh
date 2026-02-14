#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/common.sh"

required_cmd git
required_cmd node
required_cmd npm

mkdir -p "${DATA_DIR}" "${INSTANCES_DIR}" "${RUN_DIR}" "${LOG_DIR}"

for bot in cid-bot johnny5-bot; do
  mkdir -p "${ROOT_DIR}/profiles/${bot}" "${DATA_DIR}/${bot}"
  if [[ ! -f "$(profile_env_path "${bot}")" ]]; then
    cp "$(profile_env_example_path "${bot}")" "$(profile_env_path "${bot}")"
    echo "Created profile env: profiles/${bot}/env"
  fi

  bot_instance_dir="$(instance_dir "${bot}")"
  if [[ ! -d "${bot_instance_dir}/.git" ]]; then
    mkdir -p "${INSTANCES_DIR}/${bot}"
    git clone --local "${BASE_NANOCLAW_DIR}" "${bot_instance_dir}" >/dev/null
    echo "Cloned instance for ${bot}"
  fi

  git -C "${bot_instance_dir}" checkout main >/dev/null 2>&1 || true
  git -C "${bot_instance_dir}" pull --ff-only origin main >/dev/null

  if [[ ! -d "${bot_instance_dir}/node_modules" ]]; then
    echo "Installing dependencies for ${bot}..."
    (cd "${bot_instance_dir}" && npm ci)
  fi
done

echo "Setup complete."

