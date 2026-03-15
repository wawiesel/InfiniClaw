#!/bin/bash
# PostToolUse hook: flag hardcoded literals that should be read from config at runtime.
# Cross-references edited content against fleet.json values.
# Applies to operators AND bots — lives in InfiniClaw repo.
# Exit 2 + stderr = blocks the edit.
set -euo pipefail

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path')

# Only check code files, not config/env/json/md files (those ARE config)
case "$FILE_PATH" in
  *.ts|*.js|*.sh|*.bash|*.py) ;;
  *) exit 0 ;;
esac

# Skip this hook script itself
case "$FILE_PATH" in
  *check-hardcoded-literals*) exit 0 ;;
esac

# Skip test files — they legitimately use literals
case "$FILE_PATH" in
  *__tests__*|*.test.*|*.spec.*) exit 0 ;;
esac

if [[ ! -f "$FILE_PATH" ]]; then
  exit 0
fi

FLEET_JSON="$HOME/.config/infiniclaw/secrets/bots/fleet.json"
if [[ ! -f "$FLEET_JSON" ]]; then
  exit 0
fi

CONTENT=$(cat "$FILE_PATH")
VIOLATIONS=""

# Bot names — check for hardcoded lists of 3+ bot names
BOT_NAMES=$(node -e "const f=require('$FLEET_JSON'); console.log(Object.keys(f.bots).join('\n'))" 2>/dev/null)
FOUND_BOTS=()
for name in $BOT_NAMES; do
  if echo "$CONTENT" | grep -qE "(\"$name\"|'$name'|$name/\||\"$name/)" 2>/dev/null; then
    FOUND_BOTS+=("$name")
  fi
done

if [[ ${#FOUND_BOTS[@]} -ge 3 ]]; then
  VIOLATIONS+="HARDCODED BOT NAMES: found ${#FOUND_BOTS[@]} bot names as literals (${FOUND_BOTS[*]}). Read from fleet.json instead.\n"
fi

# Room IDs — should come from fleet.json quartersRoom
ROOM_IDS=$(node -e "
  const f=require('$FLEET_JSON');
  Object.values(f.bots).forEach(b => { if(b.quartersRoom) console.log(b.quartersRoom); });
" 2>/dev/null)
for room in $ROOM_IDS; do
  if echo "$CONTENT" | grep -qF "$room" 2>/dev/null; then
    VIOLATIONS+="HARDCODED ROOM ID: $room found as literal. Read from fleet.json quartersRoom instead.\n"
  fi
done

# S3 credentials
S3_KEY=$(node -e "const f=require('$FLEET_JSON'); console.log(f.s3?.secretKey||'')" 2>/dev/null)
if [[ -n "$S3_KEY" ]] && echo "$CONTENT" | grep -qF "$S3_KEY" 2>/dev/null; then
  VIOLATIONS+="HARDCODED S3 SECRET KEY found. Read from fleet.json s3 config instead.\n"
fi

if [[ -n "$VIOLATIONS" ]]; then
  echo -e "BLOCKED: Hardcoded config literals detected in $FILE_PATH:\n$VIOLATIONS\nValues from fleet.json/ships.json must be read at runtime, not hardcoded." >&2
  exit 2
fi

exit 0
