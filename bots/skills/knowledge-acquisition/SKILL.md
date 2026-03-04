---
name: knowledge-acquisition
description: Explore, organize, and extract knowledge using WKSM MCP tools. Use for filesystem exploration, file organization, document extraction, vault generation, and knowledge base management.
---

# Knowledge Acquisition

## WKSM MCP Tools

WKSM is your primary tool for filesystem and knowledge operations. Use it instead of Read/Bash for bulk exploration.

### Search & Discovery
- `wksm_search` — semantic search across indexed content
- `wksm_monitor_check` — check if a path is monitored/indexed
- `wksm_monitor_sync` — force-update a file/directory into the monitor database
- `wksm_index_auto` — index a URI for search

### Vault (Knowledge Graph)
- `wksm_vault_status` — vault overview and stats
- `wksm_vault_links` — traverse the link graph from a note
- `wksm_vault_check` — validate link targets
- `wksm_vault_sync` — sync markdown links to the edges database

### File Operations
- `wksm_mv` — move a file within monitored paths (updates monitor database)
- `wksm_cat` — retrieve content for a file path or checksum

### Transform (Document Conversion)
- `wksm_transform_list` — list available transform engines
- `wksm_transform_engine` — convert a document (PDF/DOCX → markdown)
- `wksm_transform_info` — show details for a transform engine

### Links
- `wksm_link_show` — show edges connected to a URI
- `wksm_link_sync` — sync file/directory links to database
- `wksm_link_check` — check if file is monitored and extract links

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

## Document Extraction

Extract PDFs into Obsidian-ready markdown.

### With docling (preferred — includes images)
```bash
docling <input_dir>/ --to md --output <output_dir>/Extracted --image-export-mode embedded
```
Run from the parent of `Extracted/` to avoid nesting. Fix if needed:
```bash
[ -d Extracted/Extracted ] && mv Extracted/Extracted/* Extracted/ && rmdir Extracted/Extracted/
```

### With PyMuPDF (fallback — text only)
```python
import fitz, pathlib
for pdf_path in sorted(pathlib.Path("<input_dir>").glob("*.pdf")):
    stem = pdf_path.stem
    out = pathlib.Path("<output_dir>/Extracted") / f"{stem}.md"
    if out.exists(): continue
    doc = fitz.open(pdf_path)
    pages = [f"## Page {i+1}\n\n{p.get_text()}" for i, p in enumerate(doc) if p.get_text().strip()]
    out.write_text(f"# {stem}\n\n---\n\n" + "\n\n".join(pages))
```

### With WKSM transform
```
wksm_transform_engine(engine="<engine>", uri="<file_path>")
```

**Lessons:** Docling uses 6+ GB RAM on large batches — run with `nohup`, fill gaps with PyMuPDF. Use `embedded` image mode, not `referenced`.

---

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

After writing notes, run `wksm_vault_sync` to update the link graph.

---

## Generate Meeting Vault

```
Meetings/<CONFERENCE_YEAR>/
├── INDEX.md            # Navigation hub
├── SUMMARY.md          # Overview and thread summaries
├── Presentations/      # Original PDFs
├── Extracted/          # Markdown (docling/PyMuPDF)
└── Threads/            # One .md per thread
```

1. **Define threads** — names, descriptions, keywords
2. **Extract PDFs** — docling, fill gaps with PyMuPDF
3. **Map presentations to threads** — match by keywords, add wikilinks
4. **Write thread files** — based on actual content, not fabricated
5. **Write INDEX.md and SUMMARY.md**

---

## Generate Person Profile

```
_vault/People/<Tier>/Firstname_Lastname.md
_vault/People/_photos/Firstname_Lastname/<year>/<md5checksum>.jpg
```

1. Check if person exists — update rather than create
2. Research: lab staff pages, ResearchGate, Google Scholar, ORCID
3. Download photo, save content-addressably
4. Create/update file — factual only
5. Update `_Index.md`

**Photo rules:** Don't overwrite referenced photos. Captain reviews in Obsidian. Run cleanup to purge unreferenced files.
