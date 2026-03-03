---
name: vault-exploration
description: Explore the filesystem and vault using WKSM, then collect findings as notes/summaries into the vault with links back to source files. Use when asked to explore, index, or build knowledge about projects and directories.
---

# Explore Vault

Use WKSM to explore the filesystem and vault, then write kernels/summaries back into the vault as linked notes.

## Phase 1: Explore with WKSM

- `wksm_search` — semantic search across indexed content
- `wksm_vault_status` — vault overview and stats
- `wksm_vault_links` — traverse the link graph from a note
- `wksm_vault_check` — validate link targets
- `wksm_monitor_check` — check if a path is monitored/indexed
- `wksm_index_auto` — index a URI for search

Do NOT use Read/Bash for bulk exploration — use WKSM.

## Phase 2: Write Findings to Vault

After exploring, write summaries and kernels back to the vault at `~/_vault/` (writable via `/workspace/extra/_vault/`).

**Note format:**
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
- New project discovered → `~/_vault/Projects/YYYY-ProjectName.md`
- Person encountered → `~/_vault/People/<Tier>/PersonName.md`
- Topic/concept → `~/_vault/Topics/TopicName.md`
- Follow-up action → `~/_vault/FollowUps/YYYY_MM_DD-Description.md` + add to `_Index.md`

**Linking to filesystem:** Use wikilinks with the `_links/` symlink system:
```
[[_links/mac139160/Users/ww5/path/to/file.md]]
```
Or reference paths directly in the note body.

## Phase 3: Sync Links

After writing notes, run `wksm_vault_sync` to update the link graph.

## Phase 4: Update Navigator Memory

Save key findings to MEMORY.md using the `save-memory` skill.
