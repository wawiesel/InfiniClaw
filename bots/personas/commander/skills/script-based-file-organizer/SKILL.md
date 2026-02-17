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
- **Safe by default**: Scripts run in DRY/preview mode by default. Use `GO=1 bash <script>` to execute for real.
- **Self-destructing scripts**: Each script deletes itself after a real (GO=1) run.
- **Separate cleanup script**: `cleanup_removes.sh` handles retirements, renames, and true junk deletion.

---

## Archive Rule

**2-year rule:** In year N, archive year N-2 and older to `~/Documents/_old/YYYY/`. Keep N and N-1 in home root.
- In 2026: keep 2025 + 2026 in `~/`. Move 2024 and older to `_old/`.

**WKS platform dirs — NEVER move:** `_old`, `_transform`, `_trash`, `_nltk_data`, `_vault`

---

## Directory Conventions

| Pattern | Location | Meaning |
|---------|----------|---------|
| `~/YYYY-Name/` | Home root | Active project |
| `~/Documents/YYYY-Name/` | Documents | Reference collection |
| `~/Documents/YYYY_MM-Name/` | Documents | Month-specific deliverable/event |
| `~/Documents/_old/YYYY/` | Documents | Archived projects (bucketed by year) |
| `~/deadlines/YYYY_MM_DD-Name` | Deadlines | Hard due date item |

---

## Script Template

Every `dst_<project>.sh` follows this pattern:

```bash
#!/usr/bin/env bash
# dst_<project>.sh — Route files into ~/<destination>/
# Preview: bash dst_<project>.sh
# Execute: GO=1 bash dst_<project>.sh

set -euo pipefail
HOME_DIR="$HOME"
DST="$HOME_DIR/<destination>"
DOWNLOADS="$HOME_DIR/Downloads"
LOG="$HOME_DIR/organize_log.txt"
GO="${GO:-0}"
DRY=$( [ "$GO" = "1" ] && echo 0 || echo 1 )

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }
move() {
    local src="$1" dst="$2"
    [ -e "$src" ] || { log "SKIP (not found): $src"; return 0; }
    mkdir -p "$dst"
    if [ "$DRY" = "1" ]; then log "DRY mv: '$src' -> '$dst/'"; else mv "$src" "$dst/"; log "MOVED: '$src' -> '$dst/'"; fi
}

log "=== dst_<project>.sh (GO=$GO) ==="

# --- source files -> destination ---
for f in "$DOWNLOADS"/<pattern>; do
    move "$f" "$DST"
done

log "=== done ==="
[ "$GO" = "1" ] && rm -- "$0" && echo "Script self-deleted."
```

---

## Cleanup Script Template

`cleanup_removes.sh` uses helpers for retire, remove, rename, and move:

```bash
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

remove() {
    local f="$1"
    [ -e "$f" ] || return 0
    if [ "$DRY" = "1" ]; then log "DRY rm: '$f'"; else rm -rf "$f"; log "DELETED: '$f'"; fi
}

ren() {
    local src="$1" dst="$2"
    [ -e "$src" ] || { log "SKIP (not found): $src"; return 0; }
    if [ -e "$dst" ]; then log "SKIP (dst exists): $dst"; return 0; fi
    if [ "$DRY" = "1" ]; then log "DRY mv: '$src' -> '$dst'"; else mv "$src" "$dst"; log "RENAMED: '$src' -> '$dst'"; fi
}
```

Use `retire()` for old revisions. Use `remove()` only for: `.crdownload`, `.part`, `~$*` Office temps, empty dirs, installers (.dmg). Use `ren()` for renaming non-conforming dirs to WKS convention.

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
- Non-conforming directory names (rename to `YYYY-Name` convention)

### Step 3 — Write destination scripts

One script per destination project. Name: `dst_<project>.sh`.
Store in: `/workspace/extra/_vault/Projects/`

### Step 4 — Update or write cleanup script

Add retire/remove/rename calls to `cleanup_removes.sh` for any new patterns found.

### Step 5 — Update _Index.md

Add new scripts to the index at `/workspace/extra/_vault/Projects/_Index.md`.

### Step 6 — Update memory

When the Captain corrects a routing decision or convention, immediately update MEMORY.md and this skill file.

---

## Known Routing Rules

See `/workspace/extra/_vault/Projects/_Index.md` for full project details.

Key rules learned from corrections:
- `guinea-pig-summary*.xlsx` → `~/2026-SCALEMAN/guinea-pig-results/` (NOT Benchmark-Documents, NOT Pictures)
- `WANDA*` files → `~/Documents/2026_02-WANDA_Conference/` (NOT 2025_02-)
- `rr_eol_nuc*.png` → `~/2025-FPY/` (NOT PolarisTritonDepletionGridStudy)
- Monthly DNCSH status (1.03.01.02*) → `~/2025-DNCSH/status/`
- NRC presentation support → `~/2026-NRC_Presentation_Support/`
