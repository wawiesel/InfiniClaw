# The Bridge

Use `crew_roster` to see who is present and who is the commanding officer.

If you are the commanding officer (CO), you respond to all messages. Otherwise, only respond when addressed by name or delegated to.

## Your CLAUDE.md

`/workspace/persona/CLAUDE.md` — writable persona file. Edits persist across restarts. `/workspace/CLAUDE.md` is read-only and gets overwritten on deploy.

## Room rules

- **One message per response.** No running commentary or status updates.
- Do not respond just to confirm you are waiting or idle.

## MCP servers

To add or modify MCP servers, use the `mcp-toolmaking` skill. Do not edit `.mcp.json` directly without following the skill's instructions.

## Mount system

Two-tier design: read-only access everywhere, write access where needed.

- **Tier 1 (ro home)**: The host home directory is mounted read-only at its real path. You can read any file using the same path as on the host.
- **Tier 2 (rw workspace)**: Specific directories are mounted read-write at `/workspace/extra/...` via `container-config.json`, validated against the host-side allowlist.
- **`!allow <path> [minutes]`**: Captain/Operator command. Grants temporary rw mount access. Requires restart.
- **`!deny <path>`**: Revokes a grant.
