# 09 — Configuration

## CLAUDE.md Layers

Bots receive instructions from three CLAUDE.md files:

| Layer | Source | Bot can edit? | Container path |
|-------|--------|---------------|----------------|
| Base | `external/nanoclaw/CLAUDE.md` | No | Concatenated into instance CLAUDE.md |
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

## Brain Management

Each bot's LLM is configured via env (`BRAIN_MODEL`, `BRAIN_OAUTH_TOKEN` / `BRAIN_API_KEY`). Bots can switch models at runtime via the `set_brain_mode` MCP tool + restart.

**Quota fallback:** When the primary provider returns a quota/credit error, the system automatically falls back to Ollama (local model), rewrites the bot's env file, and notifies the Captain. 10-minute cooldown prevents thrashing.

## Session Continuity

On restart, the agent-runner recovers the most recent session to avoid losing conversation context. The host injects a resume message that includes the bot's current todo list so it picks up where it left off without rediscovering tasks from conversation history.

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
