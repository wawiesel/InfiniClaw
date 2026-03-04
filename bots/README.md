# bots/

```
bots/
├── {role}/                 One directory per role (navigator, engineer, architect)
│   ├── ROOM.md             Shared room context (mounted ro at /workspace/CLAUDE.md)
│   ├── skills.json         Skills assigned to this role
│   ├── mcp.json            MCP servers for this role
│   └── {bot}/              Bot persona
│       ├── CLAUDE.md       Identity and rules (mounted rw at /workspace/persona/CLAUDE.md)
│       └── container-config.json  Extra mounts and container settings
├── skills/                 Shared skill pool
│   └── {name}/SKILL.md
└── container/              Container images
    ├── build.sh
    └── {bot}/Dockerfile
```

## Role directories

Each role has a room, skills, and MCP config shared by all bots of that role. Bots are assigned to roles via `roster.json` in the secrets repo.

## CLAUDE.md layers

1. **Base** (`external/nanoclaw/CLAUDE.md`) — framework behavior
2. **Persona** (`bots/{role}/{bot}/CLAUDE.md`) — identity and rules, writable by bot
3. **Room** (`bots/{role}/ROOM.md`) — room context, read-only

## Memory

Bot memory lives in the secrets repo (`~/.config/infiniclaw/secrets/{bot}/memory/`), mounted writable at `/workspace/persona/memory/`.
