# bots/ — Bot Definitions

Everything that defines a bot's identity, capabilities, and container image.

## Structure

```
bots/
├── roles/              Abstract capability sets (navigator, engineer, architect)
│   └── {role}/
│       ├── role.md     Role description and capabilities
│       ├── skills/     Shared skills for all bots with this role
│       └── mcp-servers/Shared MCP configs for all bots with this role
├── personas/           Concrete bot identities
│   └── {bot}/
│       ├── CLAUDE.md           Bot personality and rules (writable by bot)
│       ├── container-config.json   Extra mounts and container settings
│       ├── groups/{room}/
│       │   ├── CLAUDE.md       Room-specific context (read-only to bot)
│       │   └── .mcp.json       MCP server config for this room (writable by bot)
│       ├── skills/             Bot-specific skills (writable by bot)
│       ├── memory/             Bot knowledge base
│       └── health/             Health check scripts and data
└── container/          Docker/Podman build files
    ├── build.sh        Master build script
    └── {bot}/Dockerfile Per-bot container image
```

## Roles vs Personas

**Roles** define what a bot *can* do (navigator explores, engineer codes). **Personas** define *who* a bot is (Nora the navigator, Cid the engineer). A persona is assigned to exactly one role via `roster.json` in the secrets repo.

## CLAUDE.md layers

Bots see three instruction layers assembled at deploy time:
1. **Base** (nanoclaw CLAUDE.md) — framework behavior
2. **Persona** (this directory's CLAUDE.md) — identity and rules
3. **Group** (per-room CLAUDE.md) — room context

The persona CLAUDE.md is bind-mounted writable into the container. The bot can edit its own instructions.
