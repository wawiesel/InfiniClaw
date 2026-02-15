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

# Launch restart in a fully detached session so it survives the bot process dying.
# setsid creates a new session leader; the subshell is immune to SIGHUP/SIGTERM
# from the parent process group.
setsid bash -c "
  sleep 1
  '${SCRIPT_DIR}/stop-bot.sh' '${BOT}' 2>&1 || true
  sleep 1
  '${SCRIPT_DIR}/start-bot.sh' '${BOT}' 2>&1
" </dev/null >>"${SCRIPT_DIR}/../logs/restart-${BOT}.log" 2>&1 &

disown -a 2>/dev/null || true
echo "Restart scheduled for ${BOT} (detached pid $!)"
