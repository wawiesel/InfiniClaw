#!/usr/bin/env bash
# Clean up old Claude Code session files and ephemeral data.
# Keeps the N most recent JSONL sessions per bot (default 5).
# Also removes telemetry/ and debug/ directories which accumulate.
# Usage: session-cleanup.sh [--dry-run] [--keep N]
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTANCES_DIR="$ROOT_DIR/_runtime/instances"
KEEP=5
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --keep) KEEP="$2"; shift 2 ;;
    *) echo "Usage: $0 [--dry-run] [--keep N]"; exit 1 ;;
  esac
done

total_freed=0

for bot_dir in "$INSTANCES_DIR"/*/; do
  bot=$(basename "$bot_dir")
  sessions_base="$bot_dir/data/sessions"
  [[ -d "$sessions_base" ]] || continue

  # Clean telemetry and debug dirs
  for ephemeral in telemetry debug; do
    while IFS= read -r d; do
      size=$(du -sk "$d" 2>/dev/null | cut -f1)
      if $DRY_RUN; then
        echo "[dry-run] would remove $bot/$ephemeral (${size}KB)"
      else
        rm -rf "$d"
        echo "cleaned $bot/$ephemeral (${size}KB)"
      fi
      total_freed=$((total_freed + size))
    done < <(find "$sessions_base" -type d -name "$ephemeral" 2>/dev/null)
  done

  # Prune old session JSONL files per project dir (keep newest $KEEP)
  while IFS= read -r projdir; do
    for subdir in "$projdir"/*/; do
      [[ -d "$subdir" ]] || continue
      total=$(find "$subdir" -maxdepth 1 -name "*.jsonl" -not -name "*.tmp" 2>/dev/null | wc -l | tr -d ' ')
      if [[ $total -gt $KEEP ]]; then
        to_remove=$((total - KEEP))
        # Sort by mtime (oldest first) using stat, remove oldest
        find "$subdir" -maxdepth 1 -name "*.jsonl" -not -name "*.tmp" -exec stat -f '%m %N' {} \; 2>/dev/null | \
          sort -n | head -n "$to_remove" | while IFS= read -r line; do
            old="${line#* }"
            size=$(du -sk "$old" 2>/dev/null | cut -f1)
            if $DRY_RUN; then
              echo "[dry-run] would prune $bot/$(basename "$old") (${size}KB)"
            else
              rm -f "$old"
              echo "pruned $bot/$(basename "$old") (${size}KB)"
            fi
            total_freed=$((total_freed + size))
          done
      fi
    done
  done < <(find "$sessions_base" -path "*/.claude/projects" -type d 2>/dev/null)
done

echo "---"
if $DRY_RUN; then
  echo "Dry run complete. Would free ~${total_freed}KB"
else
  echo "Cleanup complete. Freed ~${total_freed}KB"
fi
