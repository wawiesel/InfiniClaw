---
name: obsidian-vault-generate-person
description: Add one or more people to the Obsidian vault People/ section with researched profiles and photos.
---

# Obsidian Vault: Generate Person

Add well-structured, researched people profiles to the vault.

---

## Vault Location

```
/workspace/extra/_vault/People/
├── Firstname_Lastname.md
├── Photos/
│   ├── Firstname_Lastname.jpg
│   └── _missing.txt
└── _Index.md
```

---

## File Naming

`Firstname_Lastname.md` — underscores, preserve hyphens in hyphenated names.
Photos: `Firstname_Lastname.jpg` (or `.png`)

Resolve initials (e.g., `K.J. Kelly`) to full name via web search before creating file.

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

## Education
- Ph.D. in Field, Institution (Year)

## Selected Publications
- "Title", *Journal* Vol(Issue), Year — [link]

## Context
- Presented at [[Meetings/CONF_YEAR/]] — [[Meetings/CONF_YEAR/Extracted/STEM|Title]]

## Related
- [[relevant wikilinks]]
```

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
curl -L -o /workspace/extra/_vault/People/Photos/Firstname_Lastname.jpg "<photo_url>"
```
- Prefer lab/university staff page photos
- If no photo found, add name to `_missing.txt`

### 4. Create/update the file
Keep it factual — don't fabricate. If uncertain, omit.

### 5. Update `_Index.md`
Add to appropriate section.

---

## Bulk Adding

1. Read author list source
2. Check which names already exist
3. Use Gemini delegation to batch-create minimal profiles
4. Launch parallel `general-purpose` agent batches (5-10 people each) for research + photos
5. After all batches complete, update `_Index.md` and `_missing.txt`

---

## Notes

- **LANL/LLNL**: Often restrict photos publicly
- **Last-name-first format**: Parse `"Fondement, Valentin"` correctly
- Always verify author names against actual presentation content
- Use `[[wikilinks]]` for all cross-references, never plain paths
