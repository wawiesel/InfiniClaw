# 13 — Configuration

## CLAUDE.md Layers

Bots receive instructions from three CLAUDE.md files:

| Layer | Source | Bot can edit? | Container path |
|-------|--------|---------------|----------------|
| Base | `bots/CLAUDE.md` | No | Concatenated into instance CLAUDE.md |
| Persona | `bots/{role}/{bot}/CLAUDE.md` | Yes | `/workspace/persona/CLAUDE.md` (rw) |
| Room | `bots/{role}/ROOM.md` | No | `/workspace/CLAUDE.md` (ro) |

Base + persona are concatenated into the instance-level CLAUDE.md. Room context is mounted read-only at `/workspace/CLAUDE.md` — Claude CLI finds it via directory traversal from the working directory.

## MCP Configuration

**Source of truth:** `bots/{role}/mcp.json`

Per-role, shared by all bots of that role. Changes take effect on next container spawn.

```
bots/{role}/mcp.json (on disk)
  ↓ read at spawn time by readPersonaGroupMcpServers()
  ↓ passed as mcpServers in ContainerInput JSON via stdin
  ↓ agent-runner passes to Claude SDK query()
  → Claude connects to MCP servers
```

## Chat Activity Tracking

The host tracks per-room state: current objective, last progress, last completion, last error — all with timestamps, persisted to the database. This provides state continuity across restarts.

## Startup Checklist

Sent automatically to each bot's main room on every boot, wrapped in a collapsible `<details>` block so it doesn't dominate the timeline.

### Sections by role

| Section | All bots | Engineer only | Navigator only |
|---------|----------|---------------|----------------|
| Skills | ✅ | ✅ | ✅ |
| MCP Servers | ✅ | ✅ | ✅ |
| Active Todos | ✅ | ✅ | ✅ |
| Ship Health | — | ✅ (named ship) | — |
| Weekly Goals | — | — | ✅ |
| Knowledge Search (latest entry) | — | — | ✅ |

### Rules

- **All bots** show: Skills table, MCP Servers table, Active Todos table.
- **Engineers** additionally show a Ship Health table. The table header must name the ship explicitly (e.g. `🏥 Ship Health — HERACLES`). Engineers are always in Engineering rooms.
- **Navigators** additionally show:
  1. The Captain's global weekly goal list.
  2. The latest entry from a knowledge search (most recently updated knowledge base item).
- The entire checklist is wrapped in a `<details><summary>` block so it collapses by default.

### Collapsible format

```html
<details>
<summary>🚀 Cid startup checklist</summary>

### 🔧 Skills
...tables...

</details>
```

## Verification

1. **CLAUDE.md layers loaded** — Bot starts with base + persona instructions.
   *Check:* Bot's behavior reflects both base rules and persona-specific instructions.

2. **Persona editable** — Bot modifies its own `CLAUDE.md` in the persona directory.
   *Check:* Change persists across restarts (file written to rw mount).

3. **MCP connected** — Bot has access to MCP tools defined in role's `mcp.json`.
   *Check:* Startup log shows MCP servers connected (or dropped with preflight failure).

4. **Startup checklist posted** — Bot posts collapsible checklist on boot.
   *Check:* Message appears in bot's main room with correct role-specific sections.
