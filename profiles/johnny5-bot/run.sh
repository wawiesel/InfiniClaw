#!/usr/bin/env bash
set -euo pipefail
"$(cd "$(dirname "$0")/../.." && pwd)/scripts/run-claude-session.sh" johnny5-bot "$@"
