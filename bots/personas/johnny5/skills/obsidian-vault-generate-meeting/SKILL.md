---
name: obsidian-vault-generate-meeting
description: Generate a complete Obsidian vault section for a meeting, conference, or workshop — extracted presentations, thematic threads, INDEX.md, SUMMARY.md, and bidirectional wikilinks.
---

# Obsidian Vault: Generate Meeting

Create a structured, navigable vault section for any meeting or conference.

---

## Step 0 — Define Threads First

Before extracting anything, ask:

> "What thematic threads do you want for this meeting? For each:
> - Thread name (e.g. `AI_ML`, `Fission_Product_Yields`)
> - Short description
> - Keywords to match presentations"

Do not proceed until at least one thread is defined.

---

## Vault Structure

```
Meetings/<CONFERENCE_YEAR>/
├── INDEX.md            # Navigation hub
├── SUMMARY.md          # Overview and thread summaries
├── Presentations/      # Original PDFs
├── Extracted/          # Markdown from pdf-extractor skill
│   ├── _images/
│   └── *.md
└── Threads/            # One .md per thread
    ├── Thread1.md
    └── Thread2.md
```

---

## Step 1 — Extract PDFs

Use the `pdf-extractor` skill on `Presentations/`. Output to `Extracted/`.

---

## Step 2 — Map Presentations to Threads

Read extracted markdown files, match content to threads by keywords:

```python
import pathlib

EXTRACTED = pathlib.Path("Extracted")
THREADS = {
    "Threads/ThreadName": ["keyword1", "keyword2"],
}

for md_file in sorted(EXTRACTED.glob("*.md")):
    content = md_file.read_text(encoding="utf-8").lower()
    matched = [t for t, kws in THREADS.items() if any(kw in content for kw in kws)]
    if matched:
        footer_addition = "\n*Related Threads:* " + " · ".join(f"[[../{t}]]" for t in matched)
        with open(md_file, "a") as f:
            f.write(footer_addition)
```

---

## Step 3 — Write Thread Files

Each thread file — based on **actual extracted content**, not fabricated:

```markdown
# <Thread Name>

**<Conference> — <Thread Topic>**

Brief scope description.

## Key Presentations

### 1. <Title>
**[[../../Presentations/<filename>.pdf]]** — <Presenter> (<Institution>)
- Key point from content
- Key point from content

## Key Insights

Synthesized observations across presentations.

## Connections

**People**: [[Person_Name]] — role
**Related Threads**: [[other_thread]]

## Follow-up Actions

- [ ] Action item

---
*See [[../Extracted/]] for full collection.*
```

---

## Step 4 — Write INDEX.md and SUMMARY.md

**INDEX.md:**
- Meeting name, location, dates
- Links to all threads
- Extraction status table

**SUMMARY.md:**
- 2-3 bullet summary per thread
- Extraction notes (any PyMuPDF-only files)
- Link to INDEX.md

---

## Lessons Learned

- Read extracted files before writing threads — don't fabricate content
- Keep thread files clean — don't dump raw auto-generated lists
- Bidirectional links (thread→presentation AND presentation→thread) make graph view powerful
- No clutter in vault root: archive batch logs, test scripts, status files
