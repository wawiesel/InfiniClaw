# WKS Solutions

WKS (Workspace Knowledge System) is the fleet's personal knowledge manager. It indexes, monitors, searches, and links files across the user's filesystem. Bots access it via the WKSM MCP server.

## Architecture

- **wksc** — CLI (`~/2025-WKS/main/venv/bin/wksc`)
- **wksm** — MCP server (`~/2025-WKS/main/venv/bin/wksm`), runs on port 8765
- **Config** — `~/.wks/config.json`
- **MCP endpoint in containers** — `http://host.containers.internal:8765/sse`
- **Bot mount** — `~/2025-WKS` → `/workspace/extra/2025-WKS` (engineer allow-list)

All MCP tools are prefixed `wksm__wksm__*`. The engineer role MCP config (`bots/engineer/mcp.json`) already includes WKSM.

## Key capabilities for bots

### Search
```
wksc search "<query>" [--index <name>] [-k <n>]
```
MCP: `wksm__wksm__wksm_search`

**Indexes available:**
- `main` — lexical BM25, 6163 docs, 55215 chunks. Best for exact names, file paths, specific terms.
- `semantic` — sentence-transformers embeddings, ~344 chunks / 97 docs. Best for concept queries. Includes InfiniClaw bots, skills, design docs, solutions. Path-segment boost: query terms matching directory/filename segments get higher scores.
- `images_semantic` — CLIP embeddings, 283 images.

Use `--index semantic` for meaning-based queries. Use default (`main`) for exact-term lookups.

### Index status
```
wksc index status
```
MCP: `wksm__wksm__wksm_index_status`

Current: 3 indexes, 6645 documents, 56111 chunks.

### Cat (read a file through WKS transform pipeline)
```
wksc cat <uri>
```
MCP: `wksm__wksm__wksm_cat`

Reads and transforms files (markdown, PDF, docx, xlsx, images) to text. Useful for bots to read non-text formats.

### Vault (document link graph)
```
wksc vault status    # 1910 links
wksc vault links <uri>
```
MCP: `wksm__wksm__wksm_vault_status`, `wksm__wksm__wksm_vault_links`

Tracks wiki-style links between documents. Use to find related files.

### Monitor (recently changed files)
```
wksc monitor status
wksc monitor check <path>
```
MCP: `wksm__wksm__wksm_monitor_status`, `wksm__wksm__wksm_monitor_check`

Tracks file modification times with priority scoring. Use to find recently active work areas.

### Diff
```
wksc diff <uri>
```
MCP: `wksm__wksm__wksm_diff`

Shows recent changes to a file.

## Semantic index (active on Herm)

Already configured in `~/.wks/config.json`. The daemon auto-rebuilds embeddings every 10 minutes (`embed_interval_secs: 600.0` in `daemon` config). No manual intervention needed.

If embeddings need to be rebuilt immediately:
```bash
~/2025-WKS/main/venv/bin/wksc index embed semantic
```

To add the semantic index on a new machine, add under `index.indexes` in `~/.wks/config.json`:
```json
"semantic": {
  "max_tokens": 256,
  "overlap_tokens": 64,
  "min_priority": 10.0,
  "engine": "dx",
  "embedding_model": "sentence-transformers/all-MiniLM-L6-v2",
  "embedding_mode": "text",
  "image_text_weight": null
}
```

Then backfill the key InfiniClaw content (the daemon auto-indexes new files but doesn't backfill existing ones):
```bash
# Populate semantic index with bot personas, skills, and design docs
find ~/2026-Nanoclaw/InfiniClaw/bots ~/2026-Nanoclaw/InfiniClaw/docs \
     ~/2026-Nanoclaw/CLAUDE.md ~/.claude/CLAUDE.md -name "*.md" | \
while read f; do wksc index add semantic "$f"; done

# Build embeddings
wksc index embed semantic
```

For the main (BM25) index, use `wksc index backfill main` to index all monitored files
meeting the min_priority threshold. This is slow (many files) but works for initial setup.
Do NOT run `wksc index backfill semantic` — the semantic index should be populated
from specific high-value directories only, not from all 49k monitored files.

## Excluding generated artifacts

SCALE and similar tools generate `*.htmd/` directories with hundreds of HTML files that pollute the index. The monitor filter excludes these via `exclude_globs`:

```json
"monitor": {
  "filter": {
    "exclude_globs": ["**/*.htmd/**"]
  }
}
```

This is already set on Herm. To add it on other machines, edit `~/.wks/config.json`.

After adding, clean stale DB entries and rebuild embeddings. The sync now retroactively removes excluded entries from the DB as it processes files (WKS commit `ff31fe1`). For large cleanups, directly purge MongoDB:
```bash
python3 -c "
from pymongo import MongoClient
c = MongoClient('mongodb://localhost:27017/')
r = c['wks']['nodes'].delete_many({'\$regex': r'.htmd/'})
print(f'Deleted {r.deleted_count}')
"
wksc index embed semantic
```

## Known issues (from ~/2025-WKS/ISSUES.md)

- **Noisy main index** — PDFs, generated artifacts, HTML compete with source files. Fix: `min_priority` cutoff + `exclude_globs` for generated output.
- **Repo identity underweighted** — fixed via path-segment score boost in `wks/api/search/cmd.py` (WKS commit `61444eb`). Query terms matching directory/filename path segments get a 0.2× score boost per match.
- **Semantic index size** — 135 chunks at min_priority ≥ 10.0. Grows as new high-priority files are synced. Monitor sync now sorts files newest-first (WKS commit `ff31fe1`) so recent content indexes first.

## Useful search patterns for bots

```bash
# Find by concept
wksc search "dependency injection patterns" --index semantic

# Find by exact name (lexical works fine)
wksc search "RULE.md NoHedging"

# Find recently changed files in a directory
wksc monitor check ~/2025-WKS/main

# Read a document
wksc cat file://mac139160/Users/ww5/path/to/file.md
```

## WKS URI format

Files are addressed as `file://<hostname>/<absolute-path>`. Hostname is `mac139160` on Herm.
