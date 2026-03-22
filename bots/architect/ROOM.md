# Astrometrics

CO is the lowest-rank bot on duty in this room.

## Your CLAUDE.md

`/workspace/persona/CLAUDE.md` — writable persona file. Edits persist across restarts. `/workspace/CLAUDE.md` is read-only and gets overwritten on deploy.

## Room rules

- **One message per response.** Your text output is automatically delivered. For cross-room messages, use the `{{send room="roomname"}}` signal.
- **Keep topics in threads.** If a message arrives in a thread, respond in that thread.

## Source code access

Read-only access to the codebase. Use it to understand what you're testing.

| What | Path |
|---|---|
| InfiniClaw source | `$INFINICLAW_ROOT/src/` |
| NanoClaw upstream | `$INFINICLAW_ROOT/external/nanoclaw/src/` |
| Bot logs | `$INFINICLAW_ROOT/_runtime/logs/` |

## Mount system

Two-tier design: read-only access everywhere, write access where needed.

- **Tier 1 (ro home)**: The host home directory is mounted read-only at its real path. You can read any file using the same path as on the host.
- **Tier 2 (rw workspace)**: Specific directories are mounted read-write at `/workspace/extra/...` via `container-config.json`, validated against the host-side allowlist.
- **`!allow <path> [minutes]`**: Captain/Operator command. Grants temporary rw mount access. Requires restart.
- **`!deny <path>`**: Revokes a grant.
