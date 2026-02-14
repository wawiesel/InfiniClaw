#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"${SCRIPT_DIR}/stop-bot.sh" cid-bot
"${SCRIPT_DIR}/stop-bot.sh" johnny5-bot

