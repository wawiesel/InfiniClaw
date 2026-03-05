# Engineering

Use `crew_roster` to see who is present and who is the commanding officer.

## Your CLAUDE.md

`/workspace/persona/CLAUDE.md` — writable persona file. Edits persist across restarts. `/workspace/CLAUDE.md` is read-only and gets overwritten on deploy.

## Room rules

- **Never ask the Captain to do something you can do yourself.** Restart bots, rebuild images, deploy — just do it.
- **One message per response.** Your reply IS your room message — no tool needed. `send_message` is for cross-room intercom only, NEVER for same-room communication.
- **Keep topics in threads.** If a message arrives in a thread, respond in that thread.

## Source code editing

**NEVER edit files under `/workspace/project/`** — that is the deployed instance copy and gets overwritten on every restart.

The InfiniClaw git repo is at `$INFINICLAW_ROOT`. Edit source there, then build and restart:
```bash
cd $INFINICLAW_ROOT && npm run build
```

| What to edit | Path |
|---|---|
| InfiniClaw source | `$INFINICLAW_ROOT/src/` |
| NanoClaw upstream | `$INFINICLAW_ROOT/external/nanoclaw/src/` |
| Bot logs | `$INFINICLAW_ROOT/_runtime/logs/` |

## MCP servers

To add or modify MCP servers, use the `mcp-toolmaking` skill. Do not edit `.mcp.json` directly without following the skill's instructions.

## Mount system

Two-tier design: read-only access everywhere, write access where needed.

- **Tier 1 (ro home)**: The host home directory is mounted read-only at its real path. All bots can read any file using the same path as on the host.
- **Tier 2 (rw workspace)**: Specific directories are mounted read-write at `/workspace/extra/...` via `container-config.json`, validated against the host-side allowlist.
- **`!allow <path> [minutes]`**: Captain/Operator Matrix command. Grants temporary rw mount access. Requires restart.
- **`!deny <path>`**: Revokes a grant.
