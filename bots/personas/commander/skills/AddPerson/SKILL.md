# AddPerson Skill

Add one or more people to the Obsidian vault's `People/` section with well-structured, researched profiles including photos.

---

## Vault Location

People files live at: `/workspace/extra/_vault/People/`
Photos live at: `/workspace/extra/_vault/People/Photos/`
Index: `/workspace/extra/_vault/People/_Index.md`
Missing photos log: `/workspace/extra/_vault/People/Photos/_missing.txt`

---

## File Naming

`Firstname_Lastname.md` — use underscores, preserve hyphens in hyphenated names.

Examples:
- `Amy_Lovell.md`
- `Jean-Christophe_Sublet.md`
- `Jutta_Escher.md` (resolve initials like J.E. Escher to full name via web search)

Photos: `Firstname_Lastname.jpg` (or `.png`)

---

## Full Profile Template

```markdown
# Full Name

![[Photos/Firstname_Lastname.jpg]]

**Position:** title
**Organization:** [[Organizations/<OrgName>|Organization Full Name]]
**Group/Division:** group (if known)

## Expertise
- Topic 1
- Topic 2
- Topic 3

## Education
- Ph.D. in Field, Institution (Year)
- B.S. in Field, Institution (Year)

## Selected Publications
- "Title", *Journal* Vol(Issue), Year — [link if available]

## WANDA 2026
- Presented: [[Meetings/WANDA_2026/Extracted/STEM|Short Presentation Title]]

## Related
- [[Records/Meetings/WANDA]]
```

---

## Minimal Profile (when little is known)

```markdown
# Full Name

**Position:** title or Researcher
**Organization:** institution

## Expertise
- field inferred from presentation

## WANDA 2026
- Presented: [[Meetings/WANDA_2026/Extracted/STEM|Short Title]]

## Related
- [[Records/Meetings/WANDA]]
```

---

## Steps

### 1. Check if person already exists
Search `People/` directory. If found, **update** rather than create. Read the file first.

### 2. Research the person
Search in order:
- Lab/university staff page (ORNL, LLNL, LANL, ANL, PNNL, university sites)
- ResearchGate profile
- Google Scholar profile
- ORCID
- LinkedIn (photo only — content often paywalled)
- arXiv author page

Collect: position, institution, research focus, education, key publications (3-5), contact if public.

### 3. Find and download photo
```bash
# Download photo
curl -L -o /workspace/extra/_vault/People/Photos/Firstname_Lastname.jpg "<photo_url>"
```

- Prefer lab/university staff page photos (highest quality, publicly licensed)
- ResearchGate photos work well
- Skip LinkedIn (not directly downloadable)
- If no photo found, add to `_missing.txt`

Add photo embed to profile: `![[Photos/Firstname_Lastname.jpg]]`

### 4. Create/update the file
Use the full template. Keep it factual — don't fabricate details. If uncertain, omit.

### 5. Update `_Index.md`
Add to the appropriate section. For conference presenters, add to the event section (e.g., "WANDA 2026 Presenters").

---

## Bulk Adding (from conference author list)

When adding many people at once:

1. Read `Authors.md` or equivalent source list
2. Check which names already exist in `People/`
3. Use Gemini delegation to batch-create minimal profiles from presentation content
4. Launch parallel `general-purpose` agent batches (5-10 people each) for web research + photos
5. Each batch agent should: research, download photo, write/update file
6. After all batches complete, update `_Index.md` and `_missing.txt`

Typical batch size: 10 people per agent, 5 agents in parallel.

---

## Photo Notes

- **LANL/LLNL**: Often restrict photography — photos may not be publicly available
- **University pages**: May have SSL issues with WebFetch — try direct curl
- **ResearchGate**: Usually has photos, accessible via curl
- **Google Scholar**: Small thumbnails only, not worth downloading
- If photo download fails, note in `_missing.txt` with reason

---

## Lessons from WANDA 2026

- Initials like `K.J. Kelly`, `S.M. Lyons` — resolve via web search before creating file
- Gemini works well for bulk author extraction from markdown slides
- Some authors listed with last-name-first format (e.g., "Fondement, Valentin") — parse correctly
- Always verify author name against actual presentation content (Gemini can hallucinate)
- `[[Organizations/ORNL]]`, `[[Organizations/LLNL]]`, `[[Organizations/LANL]]` are valid wikilinks
- Presentation markdown files have author name on title slide — read first 40 lines
- In vault markdown files, always use `[[wikilinks]]` for cross-references, never plain paths
- When reporting filenames in chat, use `backticks`
