---
name: infiniclaw-maintenance
description: Fix and improve InfiniClaw source code and filesystem. Use when changing source, refactoring, fixing MCP configs, updating containers, managing skills, or making any code/config changes to the system.
---

# InfiniClaw Maintenance

## Repo Layout

```
$INFINICLAW_ROOT/
├── .githooks/                       <- shared git hooks (tracked)
├── src/                             <- InfiniClaw source
├── external/nanoclaw/               <- subtree (upstream framework)
├── bots/
│   ├── CLAUDE.md                    <- base instructions (all bots)
│   ├── {role}/ROOM.md               <- shared room context (read-only)
│   ├── {role}/skills.json           <- skills assigned to this role
│   ├── {role}/mcp.json              <- MCP servers for this role
│   ├── {role}/{bot}/CLAUDE.md       <- persona identity (writable)
│   ├── {role}/{bot}/Dockerfile      <- container image (co-located with persona)
│   └── skills/{name}/SKILL.md       <- shared skill pool
└── _runtime/                        <- gitignored
```

## What Goes Where

| Change | Location |
|--------|----------|
| Bot capabilities | `bots/skills/{name}/` |
| Bot identity/rules | `bots/{role}/{bot}/CLAUDE.md` |
| Room context | `bots/{role}/ROOM.md` |
| Role skills | `bots/{role}/skills.json` |
| Role MCP servers | `bots/{role}/mcp.json` |
| InfiniClaw source | `src/` |
| Upstream fixes | `external/nanoclaw/src/` (Captain approval) |
| Container image | `bots/{role}/{bot}/Dockerfile` |
| Agent tools | `external/nanoclaw/container/agent-runner/src/tools.ts` |
| Delegate lobes | `external/nanoclaw/container/agent-runner/src/delegate-runner.ts` |

## MCP Server Configuration

**Source of truth:** `bots/{role}/mcp.json` (per-role, not per-bot)

MCP config is read by the host at container spawn time and passed to the Claude SDK. Bots cannot edit it directly — it lives outside the container.

### URL-based server (host-side service)
```json
{
  "mcpServers": {
    "server-name": {
      "type": "sse",
      "url": "http://host.containers.internal:PORT/sse"
    }
  }
}
```

### Command-based server (in-container)
```json
{
  "mcpServers": {
    "my-server": {
      "command": "my-command",
      "args": ["--flag"],
      "env": { "MY_VAR": "value" }
    }
  }
}
```

## Code Complexity Analysis

Install lizard and find refactor candidates:
```bash
pip3 install --user lizard
~/.local/bin/lizard $INFINICLAW_ROOT/src/ -s cyclomatic_complexity 2>&1 | tail -30
```

CCN > 15 = refactor candidate. Common patterns:
- Switch statements → extract each case into a handler
- Nested conditionals → guard clauses or helpers
- Long functions → split by responsibility
- Dead code → remove unused imports/exports

## Skill Design

```
skill-name/
├── SKILL.md          # Required — frontmatter + instructions
├── scripts/          # Executable code
├── references/       # Docs loaded on demand
└── assets/           # Templates, images, files
```

### Frontmatter
```yaml
---
name: skill-name          # kebab-case, matches dir name
description: What it does AND when to trigger it.
---
```

**Description is everything** — the only thing Claude always sees. Put all trigger conditions here. Body is loaded on trigger. Keep it concise.

Edit in `bots/skills/`. Assign to roles via `bots/{role}/skills.json`. Changes take effect on bot restart.

## Git Subtree Operations

```bash
cd $INFINICLAW_ROOT
# Pull upstream
git subtree pull --prefix=external/nanoclaw https://github.com/wawiesel/nanoclaw main --squash
# Push upstream
git subtree push --prefix=external/nanoclaw https://github.com/wawiesel/nanoclaw main
```

Commit InfiniClaw and nanoclaw changes separately for clean subtree push.

## Lobe Model Updates

Update defaults in `external/nanoclaw/container/agent-runner/src/delegate-runner.ts`:
1. Tool description (~line 269) — available models list
2. `effectiveModel` resolver (~line 318) — hardcoded defaults

Rules: Codex/Gemini → max-capability. Claude → sonnet or opus. Ollama → last-resort only.

## Rules

- **Skills over code** — add capabilities as skills, not source changes
- **Build after changes** — always `npm run build`
- **Never edit `/workspace/project/`** — deployed copy, overwritten on restart
