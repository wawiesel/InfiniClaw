---
name: script-based-file-organizer
description: Analyze a home directory and generate destination-first shell scripts to organize files into their correct project locations. Each script moves files to one destination. A separate cleanup script retires old revisions to _old/ subdirs.
---

# Organize Files Skill

Generate organize scripts for the Captain's home directory using the destination-first pattern.

---

## Philosophy

- **Destination-first**: Each script is named for where files are going (`dst_<project>.sh`), not where they come from.
- **Nothing stays in Downloads**: Downloads is a staging area. Every file gets routed to a project dir.
- **_old/YYYY/ beside the current version**: Old revisions don't get deleted — they go to `_old/<year>/` inside the same directory, bucketed by year extracted from the filename.
- **Self-destructing scripts**: Each script deletes itself after running for real (not DRY).
- **Separate cleanup script**: `cleanup_removes.sh` handles retirements and true junk deletion only.

---

## Directory Conventions

| Pattern | Location | Meaning |
|---------|----------|---------|
| `~/YYYY-Name/` | Home root | Active project |
| `~/Documents/YYYY-Name/` | Documents | Reference collection |
| `~/Documents/YYYY_MM-Name/` | Documents | Month-specific deliverable/event |
| `~/_old/YYYY/` | Home root | Archived completed code/dev projects (bucketed by year) |
| `~/Documents/_old/YYYY/` | Documents | Archived document/reference collections (bucketed by year) |

---

## Script Template

Every `dst_<project>.sh` follows this pattern:

```bash
#!/usr/bin/env bash
# dst_<project>.sh — Route files into ~/<destination>/
# Run: DRY=1 bash dst_<project>.sh

set -euo pipefail
HOME_DIR="$HOME"
DST="$HOME_DIR/<destination>"
DOWNLOADS="$HOME_DIR/Downloads"
LOG="$HOME_DIR/organize_log.txt"
DRY="${DRY:-0}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }
move() {
    local src="$1" dst="$2"
    [ -e "$src" ] || { log "SKIP (not found): $src"; return 0; }
    mkdir -p "$dst"
    if [ "$DRY" = "1" ]; then log "DRY mv: '$src' -> '$dst/'"; else mv "$src" "$dst/"; log "MOVED: '$src' -> '$dst/'"; fi
}

log "=== dst_<project>.sh (DRY=$DRY) ==="

# --- source files -> destination ---
for f in "$DOWNLOADS"/<pattern>; do
    move "$f" "$DST"
done

log "=== done ==="
[ "$DRY" != "1" ] && rm -- "$0" && echo "Script self-deleted."
```

---

## Cleanup Script Template

`cleanup_removes.sh` uses two helpers:

```bash
# Retire older revision to _old/YYYY/ beside the current version.
# Year is extracted from the filename; falls back to previous calendar year.
retire() {
    local f="$1"
    [ -e "$f" ] || return 0
    local dir; dir="$(dirname "$f")"
    local base; base="$(basename "$f")"
    local year; year="$(echo "$base" | grep -oE '[0-9]{4}' | head -1)"
    [ -z "$year" ] && year="$(( $(date +%Y) - 1 ))"
    local old="$dir/_old/$year"
    mkdir -p "$old"
    if [ "$DRY" = "1" ]; then log "DRY retire: '$f' -> '$old/'"; else mv "$f" "$old/"; log "RETIRED: '$f' -> '$old/'"; fi
}

# True delete — only for genuine junk (incomplete downloads, temp files, empty dirs)
remove() {
    local f="$1"
    [ -e "$f" ] || return 0
    if [ "$DRY" = "1" ]; then log "DRY rm: '$f'"; else rm -rf "$f"; log "DELETED: '$f'"; fi
}
```

Use `retire()` for old revisions. Use `remove()` only for: `.crdownload`, `.part`, `~$*` Office temps, empty dirs, root build artifacts (`node_modules`, etc.).

---

## Workflow

### Step 1 — Explore

Scan the home directory to understand what's there:
- `ls ~/`, `ls ~/Downloads/`, `ls ~/Documents/`
- Check vault Projects index: `/workspace/extra/_vault/Projects/_Index.md`
- Check existing scripts in `/workspace/extra/_vault/Projects/dst_*.sh`

### Step 2 — Identify gaps

Look for:
- Files in Downloads that belong in a known project
- Older revisions of files that need retiring
- Misrouted files

### Step 3 — Write destination scripts

One script per destination project. Name: `dst_<project>.sh`.
Store in: `/workspace/extra/_vault/Projects/`

### Step 4 — Update or write cleanup script

Add retire/remove calls to `cleanup_removes.sh` for any new revision patterns found.

### Step 5 — Update _Index.md

Add new scripts to the index at `/workspace/extra/_vault/Projects/_Index.md`.

---

## Known Projects (check vault for current list)

See `/workspace/extra/_vault/Projects/_Index.md` and `2026-SCALEMAN.md` for project details.

Key routing rules learned:
- `guinea-pig-summary*.xlsx` → `~/2026-SCALEMAN/guinea-pig-results/`
- `WANDA*` files → `~/Documents/2026_02-WANDA_Conference/` (NOT 2025_02-)
- Monthly DNCSH status PPTX → `~/2025-DNCSH-Status/`
- NRC presentation support → `~/2026-NRC_Presentation_Support/`
