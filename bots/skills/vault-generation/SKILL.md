---
name: vault-generation
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

---


# Obsidian Vault: Generate Person

Add well-structured, researched people profiles to the vault.

---

## Vault Location

```
/workspace/extra/_vault/People/
├── SubjectMatterExperts/
│   └── Firstname_Lastname.md
├── _photos/
│   └── Firstname_Lastname/
│       └── 2026/
│           └── <md5checksum>.jpg   ← content-addressable
└── _Index.md
```

---

## File Naming

`Firstname_Lastname.md` — underscores, preserve hyphens in hyphenated names.
Photos: `_photos/Firstname_Lastname/<year>/<md5checksum>.jpg` (or `.png`)

Resolve initials (e.g., `K.J. Kelly`) to full name via web search before creating file.

---

## Photo Structure

Photos are stored content-addressably by year:

```
_photos/Jean-Christophe_Sublet/
  2026/
    1098bbae.jpg    ← manually uploaded correct photo
  2024/
    b7e91a03.jpg    ← old auto-fetched (wrong person, deleted from profile)
```

**Current photo rule:** The most recent year directory that still has a file *referenced in the profile markdown* is the current photo. If a year's photo embed is deleted from the profile, it is considered discarded — the cleanup script will remove it from storage on next run.

**Skill behavior on photo fetch:**
1. Check if any file exists in `_photos/<name>/<current_year>/` AND is referenced in the profile
2. If yes → skip fetch, do not overwrite
3. If no → fetch, compute MD5 checksum (first 8 chars), save to `_photos/<name>/<current_year>/<checksum>.jpg`
4. Add embed to profile (top) and Photo History section (bottom)

**Never auto-verify.** Only the Captain removes/confirms photos by editing the profile in Obsidian.

---

## Full Profile Template

```markdown
# Full Name

![[_photos/Firstname_Lastname/2026/<checksum>.jpg]]

**Position:** title
**Organization:** [[Organizations/<OrgName>|Organization Full Name]]
**Group/Division:** group (if known)

## Expertise
- Topic 1
- Topic 2

## Education
- Ph.D. in Field, Institution (Year)

## Selected Publications
- "Title", *Journal* Vol(Issue), Year — [link]

## Context
- Presented at [[Meetings/CONF_YEAR/]] — [[Meetings/CONF_YEAR/Extracted/STEM|Title]]

## Related
- [[relevant wikilinks]]

---

## Photo History
![[_photos/Firstname_Lastname/2026/<checksum>.jpg]]
```

The main photo embed at the top shows the current photo. Photo History at the bottom shows all years as thumbnails (newest first). To discard a photo, delete its embed from Photo History — the cleanup script removes the file from storage on next run.

---

## Steps

### 1. Check if person already exists
Search `People/`. If found, **update** rather than create new.

### 2. Research
Search in order:
- Lab/university staff page (ORNL, LLNL, LANL, ANL, PNNL, universities)
- ResearchGate
- Google Scholar
- ORCID
- arXiv

Collect: position, institution, research focus, education, key publications (3-5).

### 3. Download photo
```bash
# Fetch, compute checksum, save to year directory
curl -L -o /tmp/photo_dl "<photo_url>"
CHECKSUM=$(md5sum /tmp/photo_dl | cut -c1-8)
YEAR=$(date +%Y)
mkdir -p /workspace/extra/_vault/People/_photos/Firstname_Lastname/$YEAR
mv /tmp/photo_dl /workspace/extra/_vault/People/_photos/Firstname_Lastname/$YEAR/$CHECKSUM.jpg
```
- Prefer lab/university staff page photos
- If no photo found, add name to `_missing.txt`
- **Do not overwrite** if a referenced photo already exists for the current year

### 4. Create/update the file
Keep it factual — don't fabricate. If uncertain, omit.

### 5. Update `_Index.md`
Add to appropriate section.

### 6. Run cleanup script (end of batch)
Remove any photo files in `_photos/` not referenced in any profile markdown:

```python
import os, re, glob

vault = "/workspace/extra/_vault/People"
photos_dir = os.path.join(vault, "_photos")

# Collect all referenced photo paths from markdown files
referenced = set()
for md_file in glob.glob(f"{vault}/**/*.md", recursive=True):
    with open(md_file) as f:
        for match in re.finditer(r'!\[\[(_photos/[^\]]+)\]\]', f.read()):
            referenced.add(match.group(1))

# Walk _photos/ and delete unreferenced files
removed = []
for dirpath, dirnames, filenames in os.walk(photos_dir):
    for fname in filenames:
        if fname == "_missing.txt":
            continue
        full = os.path.join(dirpath, fname)
        rel = os.path.relpath(full, vault)
        if rel not in referenced:
            os.remove(full)
            removed.append(rel)

# Remove empty directories (bottom-up)
for dirpath, dirnames, filenames in os.walk(photos_dir, topdown=False):
    if dirpath == photos_dir:
        continue
    if not os.listdir(dirpath):
        os.rmdir(dirpath)

print(f"Removed {len(removed)} unreferenced photos:")
for r in removed:
    print(f"  {r}")
```

---

## Bulk Adding

1. Read author list source
2. Check which names already exist
3. Use Gemini delegation to batch-create minimal profiles
4. Launch parallel `general-purpose` agent batches (5-10 people each) for research + photos
5. After all batches complete, update `_Index.md` and `_missing.txt`
6. Run cleanup script

---

## Notes

- **LANL/LLNL**: Often restrict photos publicly
- **Last-name-first format**: Parse `"Fondement, Valentin"` correctly
- Always verify author names against actual presentation content
- Use `[[wikilinks]]` for all cross-references, never plain paths
- **Photo curation**: The Captain reviews and deletes incorrect photos directly in Obsidian. Deleted embeds = discarded. Run cleanup to purge files from storage.
