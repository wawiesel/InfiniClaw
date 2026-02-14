#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_NANOCLAW_DIR="${ROOT_DIR}/nanoclaw"
INSTANCES_DIR="${ROOT_DIR}/instances"
DATA_DIR="${ROOT_DIR}/data"
RUN_DIR="${ROOT_DIR}/run"
LOG_DIR="${ROOT_DIR}/logs"

required_cmd() {
  local cmd="$1"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "Missing required command: ${cmd}" >&2
    exit 1
  fi
}

profile_env_path() {
  local bot="$1"
  echo "${ROOT_DIR}/profiles/${bot}/env"
}

profile_env_example_path() {
  local bot="$1"
  echo "${ROOT_DIR}/profiles/${bot}/env.example"
}

instance_dir() {
  local bot="$1"
  echo "${INSTANCES_DIR}/${bot}/nanoclaw"
}

pid_path() {
  local bot="$1"
  echo "${RUN_DIR}/${bot}.pid"
}

log_path() {
  local bot="$1"
  echo "${LOG_DIR}/${bot}.log"
}

load_profile_env() {
  local bot="$1"
  local env_file
  env_file="$(profile_env_path "${bot}")"
  if [[ ! -f "${env_file}" ]]; then
    echo "Missing profile env: ${env_file}" >&2
    echo "Copy from: $(profile_env_example_path "${bot}")" >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1090
  source "${env_file}"
  set +a
}

