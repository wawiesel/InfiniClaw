---
name: knowledge-acquisition
description: Explore, organize, and generate knowledge — vault exploration with WKSM, people/meeting vault generation, file naming conventions, and WKS integration. Use when exploring the filesystem, building vault content, or managing the knowledge base.
---

# Knowledge Acquisition

## Explore with WKSM

Use WKSM tools for discovery — not Read/Bash for bulk exploration.

- `wksm_search` — semantic search across indexed content
- `wksm_vault_status` — vault overview and stats
- `wksm_vault_links` — traverse the link graph from a note
- `wksm_vault_check` — validate link targets
- `wksm_monitor_check` — check if a path is monitored/indexed
- `wksm_index_auto` — index a URI for search

After exploring, write findings to the vault and run `wksm_vault_sync` to update the link graph.

## Vault Note Format

```markdown
# <Title>

**Source:** `~/path/to/directory/or/file`
**Indexed:** <date>

## Summary
<1-3 sentence summary>

## Key Facts
- bullet points

## Links
- [[related-vault-note]]
```

**Where to save:**
- Project → `~/_vault/Projects/YYYY-ProjectName.md`
- Person → `~/_vault/People/<Tier>/Firstname_Lastname.md`
- Topic → `~/_vault/Topics/TopicName.md`
- Follow-up → `~/_vault/FollowUps/YYYY_MM_DD-Description.md`

**Linking to filesystem:** Use wikilinks with `_links/` symlinks:
```
[[_links/mac139160/Users/ww5/path/to/file.md]]
```

---

## Generate Meeting Vault

Create structured vault sections for conferences/meetings.

### Structure
```
Meetings/<CONFERENCE_YEAR>/
├── INDEX.md            # Navigation hub
├── SUMMARY.md          # Overview and thread summaries
├── Presentations/      # Original PDFs
├── Extracted/          # Markdown from pdf-extractor skill
└── Threads/            # One .md per thread
```

### Steps
1. **Define threads first** — ask for thread names, descriptions, keywords
2. **Extract PDFs** — use `pdf-extractor` skill
3. **Map presentations to threads** — match by keywords, add wikilinks
4. **Write thread files** — based on actual content, not fabricated
5. **Write INDEX.md and SUMMARY.md**

---

## Generate Person Profile

### Location
```
_vault/People/
├── SubjectMatterExperts/
│   └── Firstname_Lastname.md
├── _photos/
│   └── Firstname_Lastname/<year>/<md5checksum>.jpg
└── _Index.md
```

### Template
```markdown
# Full Name

![[_photos/Firstname_Lastname/2026/<checksum>.jpg]]

**Position:** title
**Organization:** [[Organizations/<OrgName>|Organization Full Name]]

## Expertise
- Topic 1

## Education
- Ph.D. in Field, Institution (Year)

## Selected Publications
- "Title", *Journal* Vol(Issue), Year — [link]

## Context
- Presented at [[Meetings/CONF_YEAR/]]

## Photo History
![[_photos/Firstname_Lastname/2026/<checksum>.jpg]]
```

### Steps
1. Check if person already exists — update rather than create
2. Research: lab staff pages, ResearchGate, Google Scholar, ORCID
3. Download photo (prefer staff page), save content-addressably
4. Create/update file — factual only, don't fabricate
5. Update `_Index.md`

**Photo rules:**
- Don't overwrite if a referenced photo exists for current year
- Captain reviews/deletes incorrect photos in Obsidian
- Run cleanup script at end of batch to purge unreferenced files

---

## File & Directory Naming

**Pattern:** `<date>-<title>`

| Date | When | Example |
|------|------|---------|
| `YYYY` | Year-scoped | `2026-SCALEMAN/` |
| `YYYY_MM` | Month-scoped | `2026_02-WANDA_Conference/` |
| `YYYY_MM_DD` | Day-specific | `2026_02_17-Meeting_Notes.md` |

- **Dash (`-`)** only once — between date and title
- **Underscores (`_`)** everywhere else
- Only rename when moving, never in-place
- Never rename inside `.git` repos

## Directory Structure

```
~/YYYY-Name/              ← active project
~/Documents/YYYY-Name/    ← reference/archive
~/_old/                   ← completed projects
~/Unsorted/               ← staging for unknown files
```

## Revision Management

Keep latest in place, retire older to `_old/` beside the current version.

---

## WKS Integration

WKS treats files as nodes and relationships as edges in a knowledge graph.

- **Monitor**: discovers files, assigns `local_uri`, tracks checksums
- **Vault**: parses `[[WikiLinks]]` in Obsidian markdown
- **Transform**: converts PDFs/DOCX → markdown, cached by hash in `~/_transform/`
- **Search**: semantic + keyword search

**MCP tools**: `wksm_monitor_*`, `wksm_vault_*`, `wksm_transform_*`, `wksm_search`

**WKS repo**: `~/2025-WKS/hodor/`

Prefer standard filesystem tools (Bash, Glob, Grep, Read). Use WKS MCP as enhancement — fall back immediately if it fails.
