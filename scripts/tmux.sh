#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SESSION="${1:-infiniclaw}"

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux is required" >&2
  exit 1
fi

if tmux has-session -t "${SESSION}" 2>/dev/null; then
  tmux attach -t "${SESSION}"
  exit 0
fi

tmux new-session -d -s "${SESSION}" -n bots \
  "${SCRIPT_DIR}/start-bot.sh cid-bot; tail -f ${SCRIPT_DIR}/../logs/cid-bot.log"

tmux split-window -h -t "${SESSION}:bots" \
  "${SCRIPT_DIR}/start-bot.sh johnny5-bot; tail -f ${SCRIPT_DIR}/../logs/johnny5-bot.log"

tmux select-layout -t "${SESSION}:bots" even-horizontal
tmux attach -t "${SESSION}"

