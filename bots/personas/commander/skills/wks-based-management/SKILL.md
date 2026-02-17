---
name: wks-based-management
description: Manage the Captain's knowledge base using WKS (Wieselquist Knowledge System) conventions — naming, project structure, vault organization, and file routing.
---

# WKS-Based Knowledge Management

Guidelines for organizing and managing the Captain's knowledge base in alignment with WKS architecture.

---

## File & Directory Naming Convention

**Pattern:** `<date>-<title>`

| Date granularity | When to use | Example |
|---|---|---|
| `YYYY` | Year-scoped projects | `2026-SCALEMAN/` |
| `YYYY_MM` | Month-scoped deliverables/events | `2026_02-WANDA_Conference/` |
| `YYYY_MM_DD` | Day-specific files/notes | `2026_02_17-Meeting_Notes.md` |

**Separator rules:**
- **Dash (`-`)** appears **only once** — between the date block and the title
- **Underscores (`_`)** everywhere else: within date segments, within title words
- No spaces in filenames

**Valid examples:**
```
2026-SCALEMAN/
2026_02-WANDA_Conference/
2026_02_17-DNCSH_Status_Meeting.md
2025-Program_Planning/
2025_Q2-PMPDNCSH_rev26x.docx   ← quarter as date variant
```

**Constraints:**
- **Only rename when moving** — never rename files in-place
- **Never rename inside `.git` repos** — git tracks by name; renaming breaks history
- **Cannot control externally-generated names** — accept as-is (e.g., DOE program codes like `1.03.01.02 DNCSH FY25 Apr.pptx`)

---

## Directory Structure

```
~/YYYY-Name/              ← active project (home root)
~/Documents/YYYY-Name/   ← reference collection or deliverable archive
~/Documents/YYYY_MM-Name/ ← month-specific deliverable or event
~/_old/                  ← archived completed projects
~/Unsorted/              ← staging for unknown/ambiguous files
```

---

## Tool Usage Policy

**Prefer standard filesystem tools** (Bash, Glob, Grep, Read) for all file operations. WKS MCP tools are an enhancement, not a requirement.

When WKS MCP is available, try it — but fall back immediately to filesystem tools if it fails or produces unexpected results. Record any bugs or gaps in the **Known Issues** section below so they can be fixed.

---

## WKS Integration

WKS (Wieselquist Knowledge System) treats files as **nodes** and relationships as **edges** in a knowledge graph.

- **Monitor layer**: discovers files, assigns `local_uri`, tracks checksums
- **Vault layer**: parses `[[WikiLinks]]` in Obsidian markdown; uses `vault:///` URIs for portability
- **Transform layer**: converts PDFs/DOCX → markdown; caches by content hash in `~/_transform/`
- **Search layer**: semantic + keyword search (Vespa AI, in progress)

**`~/_transform/`**: SHA-256-keyed document cache managed by WKS. **Do not touch manually.**

**MCP tools** (when WKS is running):
- `wksm_monitor_*` — file discovery and sync
- `wksm_vault_*` — knowledge graph operations
- `wksm_transform_*` — document conversion
- `wksm_search` — semantic search

**WKS repo**: `~/2025-WKS/hodor/`

---

## Revision Management

When multiple versions of a file exist, keep the latest in place and retire older ones:

```
document_rev30.docx         ← current (in place)
_old/document_rev28.docx    ← older revision (retired here)
_old/document_rev25.docx    ← older revision
```

- `_old/` lives **beside** the current version, not at home root
- Use `cleanup_removes.sh` (via `script-based-file-organizer` skill) to automate this

---

## Project Landing Pages

Each active project should have a vault landing page at:
```
/workspace/extra/_vault/Projects/YYYY-ProjectName.md
```

Minimum contents:
- Project folder path
- Status
- Key subdirs/files
- Related projects (wikilinks)

---

## Routing Rules (Known Projects)

See `/workspace/extra/_vault/Projects/_Index.md` for the full list. Key rules:

| File pattern | Destination |
|---|---|
| `guinea-pig-summary*.xlsx` | `~/2026-SCALEMAN/guinea-pig-results/` |
| `WANDA*`, `2026-WANDA_*` | `~/Documents/2026_02-WANDA_Conference/` |
| `1.03.01.02 DNCSH FY*.pptx` | `~/2025-DNCSH-Status/` |
| NRC presentation support | `~/2026-NRC_Presentation_Support/` |
| Completed 2021-2024 projects | `~/_old/` |
| Unknown purpose | `~/Unsorted/` |

---

## Known WKS Issues

*Record bugs and gaps here as discovered. Include date and symptom.*

<!-- Example:
- 2026-02-17: `wksm_monitor_sync` returned empty result on first call — fell back to `ls`
-->
