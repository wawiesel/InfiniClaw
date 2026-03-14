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
- `semantic` — sentence-transformers embeddings, 200 high-priority docs. Best for concept queries.
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

Already configured in `~/.wks/config.json`. If embeddings need to be rebuilt:
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

## Known issues (from ~/2025-WKS/ISSUES.md)

- **Noisy main index** — PDFs, generated artifacts, HTML compete with source files. Fix: lower `min_priority` cutoff or add `exclude_globs`.
- **Repo identity underweighted** — query for a known repo name doesn't reliably surface that repo. Fix: path-boost in `wks/api/search/cmd.py`.
- **Semantic index is small** — only indexes `min_priority >= 10.0` docs (~200). Many SKILL.md/RULE.md files may be excluded. Fix: lower threshold or rebuild with `min_priority: 5.0`.

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
