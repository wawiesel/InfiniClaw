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

tmux new-session -d -s "${SESSION}" -n cid \
  "${SCRIPT_DIR}/start-bot.sh cid-bot; tail -n 200 -F ${SCRIPT_DIR}/../logs/cid-bot.log"

tmux split-window -h -t "${SESSION}:cid.0" \
  "while true; do clear; date; echo; ${SCRIPT_DIR}/status.sh; echo; echo '--- cid host log tail ---'; tail -n 30 ${SCRIPT_DIR}/../logs/cid-bot.log 2>/dev/null; sleep 2; done"

tmux split-window -v -t "${SESSION}:cid.0" \
  "${SCRIPT_DIR}/follow-latest-container-log.sh cid-bot main"

tmux select-layout -t "${SESSION}:cid" tiled

tmux new-window -t "${SESSION}" -n johnny5 \
  "${SCRIPT_DIR}/start-bot.sh johnny5-bot; tail -n 200 -F ${SCRIPT_DIR}/../logs/johnny5-bot.log"

tmux new-window -t "${SESSION}" -n controls \
  "cd ${SCRIPT_DIR}/..; echo 'Control helpers:'; echo './scripts/status.sh'; echo './scripts/stop-bot.sh cid-bot'; echo './scripts/start-bot.sh cid-bot'; echo './scripts/set-brain.sh cid-bot <model> [base_url]'; /bin/zsh"

tmux select-window -t "${SESSION}:cid"
tmux attach -t "${SESSION}"
