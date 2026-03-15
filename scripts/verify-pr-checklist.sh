#!/usr/bin/env bash
# verify-pr-checklist.sh — check open PRs for unchecked checklist items.
# Usage: ./scripts/verify-pr-checklist.sh [--repo owner/repo]
# Exits 1 if any PR has unchecked items; prints summary to stdout.
set -euo pipefail

REPO="${1:-}"
if [[ -z "$REPO" ]]; then
  REPO=$(git remote get-url origin 2>/dev/null | sed 's|.*github.com[:/]\(.*\)\.git|\1|')
fi

echo "Checking PRs in $REPO..."

prs=$(gh pr list --repo "$REPO" --state open --json number,title,body,labels --limit 50)
count=$(echo "$prs" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))")

if [[ "$count" == "0" ]]; then
  echo "No open PRs."
  exit 0
fi

fail=0
echo "$prs" | python3 - <<'PYEOF'
import sys, json, re

prs = json.load(sys.stdin)
for pr in prs:
    body = pr.get('body') or ''
    unchecked = len(re.findall(r'- \[ \]', body))
    checked   = len(re.findall(r'- \[x\]', body, re.I))
    labels    = [l['name'] for l in pr.get('labels', [])]
    is_bug    = 'bug' in labels or pr['title'].lower().startswith('fix')
    priority  = '🐛 BUG' if is_bug else '   '
    status    = '❌ BLOCKED' if unchecked else ('✅ ready' if checked else '⚠️  no checklist')
    print(f"  PR #{pr['number']:4d} {priority} {status:12s}  {pr['title'][:60]}")
    if unchecked:
        sys.exit_code = 1  # signal failure
PYEOF
