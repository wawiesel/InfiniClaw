# 11 — Containers

One bot = one Podman container. Each container runs the `agent-runner` host process which manages a hierarchy of AI processes.

## Internal Concurrency

Unlike standard container models where one container equals one process, an InfiniClaw container acts like a mini-OS:
1.  **The Agent Runner:** The Node.js entry point that manages IPC and process lifecycle.
2.  **The Main Brain (Trunk):** A persistent `claude-code` process for triage and management.
3.  **Thread Brains (Branches):** Multiple concurrent `claude-code` processes spawned for specific tasks in Matrix threads.
4.  **Async Lobes (Workers):** Stateless subprocesses for fast execution.

This architecture ensures the bot is always reachable on the main timeline regardless of how many complex tasks are running in parallel.

## Mount System

Two-tier design: read-only everywhere, write access where needed.

**Tier 1: Read-only home mirror** — The host home directory is mounted at its real path inside every container, read-only. Bots read files using the same paths as on the host. Added automatically by `container-mounts.ts`.

**Tier 2: Read-write workspace mounts** — Per-bot directories mounted at `/workspace/extra/...` via `container-config.json`. Validated against the host-side allowlist (`~/.config/infiniclaw/allow-list.json`). The Captain grants/revokes temporary mounts via `!allow <path> [minutes]` / `!deny <path>`.

## Secrets

- **No credentials in git.** Bot env files live in the secrets repo (`~/.config/infiniclaw/secrets/`). `.mcp.json` files (may contain OAuth tokens) are gitignored.
- **Secrets flow:** profile env files → loaded by host process → injected as `--env` into containers. Nothing baked into images.
- **Mount allowlist** is stored outside the repo (`~/.config/nanoclaw/mount-allowlist.json`) so containers can't tamper with it.
