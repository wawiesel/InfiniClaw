#!/usr/bin/env bash
# Rebuild InfiniClaw: install deps if needed, then compile.
# Called by rebuildInfiniClaw() in relay.ts. This script is pulled
# via git BEFORE execution, so it can be updated without recompiling
# the relay — solving the chicken-and-egg problem with new dependencies.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Install deps if package-lock.json changed
LOCK="$ROOT/package-lock.json"
HASH_FILE="$ROOT/node_modules/.package-lock-hash"
if [ ! -d "$ROOT/node_modules" ]; then
  npm install
elif [ -f "$LOCK" ]; then
  CURRENT=$(md5sum "$LOCK" 2>/dev/null | cut -d' ' -f1 || md5 -q "$LOCK")
  STORED=$(cat "$HASH_FILE" 2>/dev/null || echo "")
  if [ "$CURRENT" != "$STORED" ]; then
    npm install
    echo "$CURRENT" > "$HASH_FILE"
  fi
fi

# Build (nanoclaw workspace first, then InfiniClaw)
npm run build -w nanoclaw
tsc
