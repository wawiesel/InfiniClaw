#!/usr/bin/env bash
# Rebuild InfiniClaw: install deps, then compile.
# Called via package.json "build" so it works with any relay version.
set -euo pipefail
cd "$(dirname "$0")/.."

npm install --ignore-scripts 2>/dev/null
npm run build -w nanoclaw
npx tsc
