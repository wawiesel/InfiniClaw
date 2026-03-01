---
name: knowledge-extractor
description: Extract knowledge from PDFs or documents into Obsidian-ready markdown. Uses docling (preferred, with images) and PyMuPDF (fallback). Works for conferences, reference libraries, or any document collection.
---

# Knowledge Extractor Skill

Extract a directory of PDFs into clean markdown, ready for Obsidian.

---

## Step 1 — Set Up Output Structure

```
<OutputDir>/
├── Extracted/     # Markdown files go here
└── _images/       # Embedded images (from docling)
```

---

## Step 2 — Extract with Docling (Preferred)

```bash
docling <input_dir>/ --to md --output <OutputDir>/Extracted --image-export-mode embedded
```

**Important:** Run from the parent of `Extracted/`, not from inside it, or you get `Extracted/Extracted/` nesting.

After docling completes, check and fix nesting:
```bash
[ -d Extracted/Extracted ] && mv Extracted/Extracted/* Extracted/ && rmdir Extracted/Extracted/
```

---

## Step 3 — Fill Gaps with PyMuPDF (Fallback)

For any PDFs docling failed on (corrupted, malformed):

```python
import fitz, pathlib

INPUT = pathlib.Path("<input_dir>")
EXTRACTED = pathlib.Path("<OutputDir>/Extracted")

for pdf_path in sorted(INPUT.glob("*.pdf")):
    stem = pdf_path.stem
    out_path = EXTRACTED / f"{stem}.md"
    if out_path.exists():
        continue  # docling already got it
    try:
        doc = fitz.open(pdf_path)
        pages = [f"## Page {i+1}\n\n{page.get_text()}" for i, page in enumerate(doc) if page.get_text().strip()]
        content = f"# {stem}\n\n**Source:** `{pdf_path.name}`\n**Pages:** {len(doc)}\n\n---\n\n" + "\n\n".join(pages)
        out_path.write_text(content, encoding="utf-8")
        print(f"✓ PyMuPDF: {stem}")
    except Exception as e:
        print(f"✗ FAILED: {stem} — {e}")
```

---

## Step 4 — Add Backlinks (Optional)

Add a footer to each extracted file linking back to its source PDF and any related context:

```python
import pathlib

EXTRACTED = pathlib.Path("<OutputDir>/Extracted")

for md_file in sorted(EXTRACTED.glob("*.md")):
    content = md_file.read_text(encoding="utf-8")
    if "Source PDF:" in content:
        continue
    stem = md_file.stem
    footer = f"\n\n---\n*Source PDF:* [[../Presentations/{stem}.pdf|{stem}]]"
    with open(md_file, "a", encoding="utf-8") as f:
        f.write(footer)
```

---

## Lessons Learned

- **Docling nesting bug**: Always run from the parent of `Extracted/`
- **OOM kills**: Docling on 70+ PDFs uses 6+ GB RAM. Run in background (`nohup`), monitor, fill gaps with PyMuPDF
- **Image export mode**: Use `--image-export-mode embedded` (base64 inline) — `referenced` creates broken paths
- **Malformed PDFs**: ~10% of conference PDFs may be corrupted. PyMuPDF handles these but without images
- **Pre-commit hooks**: Vault git hooks may fail in container — disable if needed
