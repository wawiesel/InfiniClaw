#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"${SCRIPT_DIR}/start-bot.sh" cid-bot
"${SCRIPT_DIR}/start-bot.sh" johnny5-bot

