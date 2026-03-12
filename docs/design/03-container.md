# 03 — Containers

One bot = one persistent Podman container. The container starts when the bot wakes and stays running until the bot sleeps. Inside it, a hierarchy of AI processes handles triage, execution, and delegation.

## Internal Concurrency

An InfiniClaw container acts like a mini-OS:
1.  **The Agent Runner:** The Node.js entry point (`/app/entrypoint.sh` → `node /app/dist/index.js`) that manages IPC and process lifecycle.
2.  **The Main Brain (Trunk):** A persistent `claude-code` process spawned by the agent runner for triage and management. It does NOT restart per message — it stays running and receives new messages via IPC.
3.  **Async Lobes (Workers):** Stateless subprocesses (Codex, Gemini, Claude, Ollama) spawned by the delegate runner for fast parallel execution. Results returned via IPC files.

**Branch brains** run on the host (not inside containers). The relay spawns them as `claude --print` processes that communicate via Matrix threads. See [08-threading](08-threading.md).

This architecture ensures the bot is always reachable on the main timeline regardless of how many complex tasks are running in parallel.

## Image Build

Each bot has a Dockerfile at `bots/{role}/{persona}/Dockerfile` (e.g. `bots/engineer/cid/Dockerfile`). All share a common build context at `bots/container/` which contains the agent-runner source.

Build flow: `bots/build.sh {bot}` discovers the Dockerfile, builds with `bots/container/` as context, tags as `nanoclaw-{bot}:latest`.

Images are rebuilt automatically on deploy by hashing the Dockerfile + agent-runner contents.

## Mount System

Two-tier design: read-only everywhere, write access where needed.

**Tier 1: Read-only home mirror** — The host home directory is mounted at its real path inside every container, read-only. Bots read files using the same paths as on the host.

**Tier 2: Read-write workspace mounts** — Per-bot directories mounted at `/workspace/extra/...` via the host-side allowlist (`~/.config/infiniclaw/allow-list.json`). The Captain grants/revokes temporary mounts via `!allow <path> [minutes]` / `!deny <path>`.

### Mount table

| Container path | Source | Mode | Purpose |
|---|---|---|---|
| `{homeDir}` | Host home directory | ro | File access at real paths |
| `/workspace/persona` | `bots/{role}/{persona}/` | rw | Bot can edit own CLAUDE.md |
| `/workspace/persona/memory` | `secrets/bots/{persona}/memory/` | rw | Persistent memory across sessions |
| `/workspace/CLAUDE.md` | `bots/{role}/ROOM.md` | ro | Room-level instructions |
| `/workspace/cache` | `_runtime/instances/{bot}/data/cache/{group}/` | rw | Per-group persistent cache |
| `/workspace/ipc` | `_runtime/instances/{bot}/data/ipc/{group}/` | rw | Host ↔ container communication |
| `/app/src` | NanoClaw agent-runner source | ro | Agent runner source |
| `/home/node/.ssh` | `~/.ssh/` | rw | Git SSH keys |
| `/home/node/.codex` | `~/.codex/` | rw | Codex delegate auth |
| `/home/node/.gemini` | `~/.gemini/` | rw | Gemini delegate auth |
| `/home/node/.claude` | `_runtime/instances/{bot}/data/sessions/{group}/.claude/` | rw | Claude Code session state |
| `/workspace/extra/*` | Allow-listed paths | rw | Captain-granted mounts |

## Secrets

- **No credentials in git.** Bot env files live in the secrets repo (`~/.config/infiniclaw/secrets/`). `.mcp.json` files (may contain OAuth tokens) are gitignored.
- **Secrets flow:** Profile env files → loaded by host process → written to a mounted env file at `/workspace/env-dir/env` (read-only inside container). The entrypoint sources this file. `CONTAINER_ENV_*` vars are injected separately as `-e` flags with the prefix stripped.
- **Credential proxy:** Containers never see real API keys. `ANTHROPIC_BASE_URL` points to a host-side proxy that injects credentials per-request.
- **Mount allowlist** is stored outside the repo (`~/.config/infiniclaw/allow-list.json`) so containers can't tamper with it.
- **Cert mapping:** Host CA cert paths are mapped to container-compatible locations for Node, Python, curl, and git (`NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`).

## Verification

1. **Podman running** — `podman machine list` shows a running VM.
   *Check:* Machine status is "Running".

2. **Image builds** — `bash bots/build.sh cid` completes.
   *Check:* Exit code 0, `podman images` shows `nanoclaw-cid:latest`.

3. **Container runs** — `podman run --rm nanoclaw-cid:latest echo hello` prints output.
   *Check:* Output is "hello".

4. **Mounts work** — Container can read host home directory (ro) and write to workspace (rw).
   *Check:* `cat /home/user/somefile` succeeds (ro), `touch /workspace/persona/test` succeeds (rw).
