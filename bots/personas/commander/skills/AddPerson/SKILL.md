# AddPerson Skill

Add one or more people to the Obsidian vault's `People/` section with well-structured profiles.

---

## Vault Location

People files live at: `/workspace/extra/_vault/People/`
Index: `/workspace/extra/_vault/People/_Index.md`

---

## File Naming

`Firstname_Lastname.md` — use underscores, no special characters.

Examples:
- `Amy_Lovell.md`
- `Jean-Christophe_Sublet.md`
- `J_E_Escher.md` (for initials-only names)

---

## Profile Template

```markdown
# Full Name

**Position:** <title>
**Organization:** [[Organizations/<OrgName>|Organization Full Name]]
**Group/Division:** <group if known>

## Expertise
- Topic 1
- Topic 2
- Topic 3

## Education
- Degree, Institution (Year if known)

## Related
- [[Records/Meetings/WANDA]] (if met at WANDA)
- [[Meetings/WANDA_2026/Extracted/<presentation_file>]] (if they presented)
```

---

## Minimal Profile (when little is known)

If only name and institution are known (e.g., from a conference author list):

```markdown
# Full Name

**Position:** <title or unknown>
**Organization:** <institution>

## Expertise
- <field, inferred from presentation topic if available>

## Related
- [[Records/Meetings/WANDA]]
- [[Meetings/WANDA_2026/Extracted/<presentation_file>]]
```

---

## Steps

1. **Check if person already exists** — search `People/` for the name. If found, update rather than create.

2. **Research the person** — use `agent-browser` skill or web search to find:
   - Current position and institution
   - Research focus / expertise
   - Education (if publicly available)
   - Lab page, ResearchGate, LinkedIn, Google Scholar

3. **Create the file** — use the template above. Keep it concise. Don't fabricate details.

4. **Update `_Index.md`** — add the person to the appropriate section (ORNL Colleagues, External Collaborators, WANDA Presenters, etc.)

---

## Bulk Adding (from conference author list)

When adding many people at once (e.g., all WANDA presenters):

1. Read `Authors.md` or equivalent source list
2. Check which names already exist in `People/`
3. For each new person, create a minimal profile referencing their presentation
4. Use `agent-browser` to look up 3-5 at a time for efficiency
5. Add a "WANDA 2026 Presenters" section to `_Index.md`

---

## Lessons from WANDA 2026

- Many presenters use initials (e.g., `K.J. Kelly`, `S.M. Lyons`) — try to resolve full first names via web search
- Gemini delegation works well for bulk author extraction from markdown
- Some names may already exist (check before creating)
- Affiliation often visible in the first slide of their presentation markdown
- `[[Organizations/ORNL]]`, `[[Organizations/LLNL]]`, `[[Organizations/LANL]]` etc. are valid wikilinks if those org files exist
