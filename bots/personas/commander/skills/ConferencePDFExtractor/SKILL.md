# ConferencePDFExtractor Skill

Extract conference PDFs into Obsidian-ready markdown with thematic threads and bidirectional links.

---

## Step 0 — Ask for Threads FIRST

Before doing anything else, ask the user:

> "What thematic threads do you want for this conference? For each thread, provide:
> - Thread name (e.g. `AI_ML`, `Fission_Product_Yields`)
> - A short description
> - Keywords to match presentations to this thread"

Do not proceed until you have at least one thread defined.

---

## Step 1 — Set Up Vault Structure

```
<Conference>/
├── INDEX.md            # Navigation hub
├── SUMMARY.md          # Overview and thread summaries
├── Presentations/      # Original PDFs (may already exist)
├── Extracted/          # Markdown files go here
└── Threads/            # One .md per thread
```

Create the `Threads/` directory and one markdown file per thread with a rich template (see Step 4).

---

## Step 2 — Extract PDFs

Run docling first (best quality, images included):

```bash
cd <Conference>
docling Presentations/ --to md --output Extracted --image-export-mode embedded
```

**Important:** Run from the parent of `Extracted/`, not from inside it, or you get `Extracted/Extracted/` nesting.

After docling completes, check for `Extracted/Extracted/` nesting and fix if present:
```bash
mv Extracted/Extracted/* Extracted/ && rmdir Extracted/Extracted/
```

Identify which PDFs failed (docling can't handle corrupted/malformed PDFs). Fill gaps with PyMuPDF:

```python
import fitz, os, pathlib

PRESENTATIONS = pathlib.Path("Presentations")
EXTRACTED = pathlib.Path("Extracted")

for pdf_path in sorted(PRESENTATIONS.glob("*.pdf")):
    stem = pdf_path.stem
    out_path = EXTRACTED / f"{stem}.md"
    if out_path.exists():
        continue  # docling already got it
    try:
        doc = fitz.open(pdf_path)
        pages = []
        for i, page in enumerate(doc):
            text = page.get_text()
            if text.strip():
                pages.append(f"## Page {i+1}\n\n{text}")
        content = f"# {stem}\n\n**Source:** `{pdf_path.name}`\n**Pages:** {len(doc)}\n\n---\n\n" + "\n\n".join(pages)
        out_path.write_text(content, encoding="utf-8")
        print(f"✓ PyMuPDF: {stem}")
    except Exception as e:
        print(f"✗ FAILED: {stem} — {e}")
```

---

## Step 3 — Add Backlinks to Extracted Files

Add a footer to every extracted markdown file with:
- Link back to source PDF
- Links to matching threads (based on keyword matching)

```python
import os, pathlib

EXTRACTED = pathlib.Path("Extracted")
THREADS = {
    "Threads/ThreadName": ["keyword1", "keyword2"],
    # ... one entry per thread
}

for md_file in sorted(EXTRACTED.glob("*.md")):
    content = md_file.read_text(encoding="utf-8")
    if "Source PDF:" in content:
        continue  # already done

    stem = md_file.stem
    text_lower = content.lower()
    matched = [t for t, kws in THREADS.items() if any(kw in text_lower for kw in kws)]

    footer = f"\n\n---\n*Source PDF:* [[../Presentations/{stem}.pdf|{stem}]]"
    if matched:
        links = " · ".join(f"[[../{t}]]" for t in matched)
        footer += f"\n*Related Threads:* {links}"

    with open(md_file, "a", encoding="utf-8") as f:
        f.write(footer)
```

---

## Step 4 — Create Thread Files

Each thread file should be rich, not just a list. Structure:

```markdown
# <Thread Name>

**<Conference> - <Thread Topic>**

Brief description of the thread's scope and why it matters.

## Key Presentations

### 1. <Title>
**[[../../Presentations/<filename>.pdf]]** - <Presenter> (<Institution>)
- Bullet points of key content extracted from the PDF

(repeat for each relevant presentation)

## Key Insights

Synthesized observations across presentations.

## Connections

**People**: [[Person_Name]] - role
**Related Threads**: [[other_thread]]

## Follow-up Actions

- [ ] Action item

---
*See [[../Extracted/]] for full presentation collection.*
```

Write thread files based on actual content from the extracted markdown — read the files, don't fabricate.

---

## Step 5 — Write INDEX.md and SUMMARY.md

**INDEX.md** — clean navigation:
- Conference metadata (name, location, dates, website)
- Links to all threads
- Extraction status table (docling count, PyMuPDF count, total)

**SUMMARY.md** — content overview:
- 2-3 bullet summary per thread
- Extraction notes listing any PyMuPDF-only files (malformed PDFs)
- Link to INDEX.md

---

## Lessons Learned (WANDA 2026)

- **Docling nesting bug**: Always run docling from the parent directory, not inside `Extracted/`
- **OOM kills**: Docling on 70+ PDFs uses 6+ GB RAM and can be killed. Run in background, monitor, fill gaps with PyMuPDF
- **Malformed PDFs**: ~10% of conference PDFs may be corrupted/malformed. PyMuPDF handles these but without images
- **Image export mode**: Use `--image-export-mode embedded` (base64 in markdown) — `referenced` creates broken paths
- **No INDEX.md**: Obsidian doesn't auto-generate indexes; create one manually
- **Backlinks before threads**: Add backlinks to `Extracted/` files so Obsidian graph view shows connections immediately
- **Keep it clean**: No CLEANUP_SUMMARY, Extraction_Status, Thread_Mapping, batch logs, or test scripts in the vault root — archive or delete them
- **Pre-commit hooks**: Vault git hooks may require WKS Python modules not available in the container; disable the hook if needed
