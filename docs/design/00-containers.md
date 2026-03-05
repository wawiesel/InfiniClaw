# 00 — Containers

One bot = one Podman container. Each container runs the agent-runner (which spawns Claude Code CLI) with the bot's persona, tools, and mounts. The host injects secrets as env vars — nothing is baked into images.

Containers run with memory caps (`CONTAINER_MEMORY_MB`, default 6GB) and optional CPU limits. There must never be multiple containers for the same bot, except interrupt lobes (which use `containerNameTag: 'interrupt'` to coexist).

## Mount System

Two-tier design: read-only everywhere, write access where needed.

**Tier 1: Read-only home mirror** — The host home directory is mounted at its real path inside every container, read-only. Bots read files using the same paths as on the host. Added automatically by `container-mounts.ts`.

**Tier 2: Read-write workspace mounts** — Per-bot directories mounted at `/workspace/extra/...` via `container-config.json`. Validated against the host-side allowlist (`~/.config/infiniclaw/allow-list.json`). The Captain grants/revokes temporary mounts via `!allow <path> [minutes]` / `!deny <path>`.

## Secrets

- **No credentials in git.** Bot env files live in the secrets repo (`~/.config/infiniclaw/secrets/`). `.mcp.json` files (may contain OAuth tokens) are gitignored.
- **Secrets flow:** profile env files → loaded by host process → injected as `--env` into containers. Nothing baked into images.
- **Mount allowlist** is stored outside the repo (`~/.config/nanoclaw/mount-allowlist.json`) so containers can't tamper with it.
