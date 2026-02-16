#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_NANOCLAW_DIR="${ROOT_DIR}/nanoclaw"
INSTANCES_DIR="${ROOT_DIR}/_runtime/instances"
DATA_DIR="${ROOT_DIR}/_runtime/data"
RUN_DIR="${ROOT_DIR}/_runtime/run"
LOG_DIR="${ROOT_DIR}/_runtime/logs"

required_cmd() {
  local cmd="$1"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "Missing required command: ${cmd}" >&2
    exit 1
  fi
}

profile_env_path() {
  local bot="$1"
  echo "${ROOT_DIR}/bots/profiles/${bot}/env"
}

profile_env_example_path() {
  local bot="$1"
  echo "${ROOT_DIR}/bots/profiles/${bot}/env.example"
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

apply_brain_env() {
  # Unified "brain" knobs for each bot profile.
  # Clear all mapped vars first to prevent leaking between bots.
  unset ANTHROPIC_MODEL ANTHROPIC_SMALL_FAST_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN 2>/dev/null || true

  # Map BRAIN_* onto NanoClaw runtime env.
  if [[ -n "${BRAIN_MODEL:-}" ]]; then
    export ANTHROPIC_MODEL="${BRAIN_MODEL}"
    # Set all SDK model slots to the same model so haiku/sonnet
    # fallbacks never try models the backend doesn't have.
    export ANTHROPIC_SMALL_FAST_MODEL="${BRAIN_MODEL}"
    export ANTHROPIC_DEFAULT_SONNET_MODEL="${BRAIN_MODEL}"
  fi
  if [[ -n "${BRAIN_BASE_URL:-}" ]]; then
    export ANTHROPIC_BASE_URL="${BRAIN_BASE_URL}"
  fi
  if [[ -n "${BRAIN_AUTH_TOKEN:-}" ]]; then
    export ANTHROPIC_AUTH_TOKEN="${BRAIN_AUTH_TOKEN}"
  fi
  if [[ -n "${BRAIN_API_KEY:-}" ]]; then
    export ANTHROPIC_API_KEY="${BRAIN_API_KEY}"
  fi
  if [[ -n "${BRAIN_OAUTH_TOKEN:-}" ]]; then
    export CLAUDE_CODE_OAUTH_TOKEN="${BRAIN_OAUTH_TOKEN}"
  fi

  # Local fallback: if no explicit profile OAuth token is set, reuse
  # the operator's local NanoClaw token from nearby .env files.
  if [[ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
    local candidate_envs=(
      "${ROOT_DIR}/nanoclaw/.env"
      "${ROOT_DIR}/../nanoclaw/.env"
    )
    local env_file
    for env_file in "${candidate_envs[@]}"; do
      if [[ -f "${env_file}" ]]; then
        local token_line
        token_line="$(rg -n '^CLAUDE_CODE_OAUTH_TOKEN=' "${env_file}" -N -S | head -n1 || true)"
        if [[ -n "${token_line}" ]]; then
          local token_value
          token_value="${token_line#CLAUDE_CODE_OAUTH_TOKEN=}"
          token_value="${token_value%\"}"
          token_value="${token_value#\"}"
          token_value="${token_value%\'}"
          token_value="${token_value#\'}"
          if [[ -n "${token_value}" ]]; then
            export CLAUDE_CODE_OAUTH_TOKEN="${token_value}"
            break
          fi
        fi
      fi
    done
  fi
}

ensure_podman_ready() {
  if ! command -v podman >/dev/null 2>&1; then
    echo "podman not found in PATH" >&2
    return 1
  fi

  if podman info >/dev/null 2>&1; then
    return 0
  fi

  # Best effort: recover default machine if podman API is unavailable.
  podman machine stop podman-machine-default >/dev/null 2>&1 || true
  podman machine start podman-machine-default >/dev/null 2>&1 || true

  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if podman info >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "Podman API unavailable after recovery attempt." >&2
  echo "Try: podman machine stop podman-machine-default && podman machine start podman-machine-default" >&2
  return 1
}

validate_brain_env() {
  if [[ -n "${ANTHROPIC_BASE_URL:-}" ]]; then
    if [[ -z "${ANTHROPIC_AUTH_TOKEN:-}" && -z "${ANTHROPIC_API_KEY:-}" && -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
      echo "BRAIN_BASE_URL is set but no auth token is configured." >&2
      echo "Set BRAIN_AUTH_TOKEN, BRAIN_API_KEY, or BRAIN_OAUTH_TOKEN in profile env." >&2
      return 1
    fi
  fi
}

write_env_if_set() {
  local file="$1"
  local key="$2"
  local val="${!key:-}"
  if [[ -n "${val}" ]]; then
    printf '%s=%s\n' "${key}" "${val}" >> "${file}"
  fi
}

# Save runtime group .md files from instance → personas/ (captures bot memory changes)
sync_persona() {
  local bot="$1"
  local instance
  instance="$(instance_dir "$bot")"
  local persona="${ROOT_DIR}/bots/personas/${bot}"
  [[ -d "${persona}" ]] || return 0

  # SAVE: capture runtime changes from instance groups → personas
  if [[ -d "${instance}/groups" ]]; then
    for group_dir in "${instance}/groups"/*/; do
      [[ -d "$group_dir" ]] || continue
      local gname
      gname="$(basename "$group_dir")"
      for md in "${group_dir}"*.md; do
        [[ -f "$md" ]] || continue
        mkdir -p "${persona}/groups/${gname}"
        cp "$md" "${persona}/groups/${gname}/$(basename "$md")"
      done
    done
  fi
}

# Append persona CLAUDE.md to instance base and seed group files
restore_persona() {
  local bot="$1"
  local instance
  instance="$(instance_dir "$bot")"
  local persona="${ROOT_DIR}/bots/personas/${bot}"
  [[ -d "${persona}" ]] || return 0

  # Append persona CLAUDE.md to base CLAUDE.md
  if [[ -f "${persona}/CLAUDE.md" ]]; then
    printf '\n' >> "${instance}/CLAUDE.md"
    cat "${persona}/CLAUDE.md" >> "${instance}/CLAUDE.md"
  fi

  # RESTORE: seed group files from personas → instance groups
  if [[ -d "${persona}/groups" ]]; then
    for gdir in "${persona}/groups"/*/; do
      [[ -d "$gdir" ]] || continue
      local gname
      gname="$(basename "$gdir")"
      mkdir -p "${instance}/groups/${gname}"
      cp "${gdir}"*.md "${instance}/groups/${gname}/" 2>/dev/null || true
    done
  fi
}
