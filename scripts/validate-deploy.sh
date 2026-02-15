#!/usr/bin/env bash
# Validate vendored nanoclaw/ code compiles before allowing a restart.
# Usage: validate-deploy.sh <bot>
# Exit 0 = valid, non-zero = errors on stderr.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/common.sh"

bot="${1:?Usage: validate-deploy.sh <bot>}"
instance="$(instance_dir "$bot")"

staging="${ROOT_DIR}/staging/${bot}/nanoclaw"
mkdir -p "$staging"

# Sync vendored source to staging (same excludes as supervisor)
rsync -a --delete \
  --exclude node_modules \
  --exclude data \
  --exclude store \
  --exclude groups \
  --exclude logs \
  "${BASE_NANOCLAW_DIR}/" "${staging}/"

# Symlink node_modules from live instance to avoid reinstall
if [[ -d "${instance}/node_modules" ]]; then
  ln -sfn "${instance}/node_modules" "${staging}/node_modules"
fi

# Run type check
cd "$staging"
npx tsc --noEmit
