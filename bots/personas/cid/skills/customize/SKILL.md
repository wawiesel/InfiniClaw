---
name: customize
description: Add new capabilities or modify InfiniClaw behavior. Use when the Captain wants to add channels, change triggers, add MCP integrations, modify bot personas, or make any other customizations.
---

# InfiniClaw Customization

## Key Files

| What to change | File |
|----------------|------|
| Bot identity, rules, capabilities | `bots/personas/{bot}/CLAUDE.md` |
| Per-room context and instructions | `bots/personas/{bot}/groups/{room}/CLAUDE.md` |
| Bot container config (mounts, ports) | `bots/personas/{bot}/container-config.json` |
| MCP servers for a room | `bots/personas/{bot}/groups/{room}/.mcp.json` |
| Skills available to a bot | `bots/personas/{bot}/skills/` |
| Host orchestration | `src/main.ts` |
| Matrix channel behavior | `src/channels/matrix.ts` |
| IPC command handling | `src/ipc-commands.ts` |
| IPC message routing | `src/ipc-watcher.ts` |
| Container spawn logic | `src/container-spawn.ts` |
| Agent tools (MCP tools available in container) | `external/nanoclaw/container/agent-runner/src/tools.ts` |
| Delegate lobes (codex/gemini/ollama) | `external/nanoclaw/container/agent-runner/src/delegate-runner.ts` |

## Common Customizations

### Add an MCP Server to a Bot
1. Edit `bots/personas/{bot}/groups/{room}/.mcp.json` — add entry to `mcpServers`
2. **Validate JSON** (`python3 -m json.tool <file>`) — trailing commas cause silent failure
3. Restart the bot: `restart_self(bot="{bot}")`
4. Verify: check `_runtime/instances/{bot}/groups/{room}/mcp-debug.json` for `hasMcpServers: true`

### Add a New Agent Tool (IPC)
1. Add tool in `external/nanoclaw/container/agent-runner/src/tools.ts`
2. If it writes an IPC task: add handler in `src/ipc-commands.ts`
3. `npm run build` in `$INFINICLAW_ROOT`, then restart

### Add a New Channel
1. Implement the `Channel` interface from `external/nanoclaw/src/types.ts`
2. Create `src/channels/{name}.ts` — use `src/channels/matrix.ts` as reference
3. Register in `src/main.ts` alongside existing channels
4. Each channel needs a JID prefix (e.g. `matrix:`, `slack:`)

### Modify Bot Persona
- Edit `bots/personas/{bot}/CLAUDE.md` directly — persists across restarts
- Or edit from inside the container via the persona mount at `/workspace/extra/{bot}-persona/CLAUDE.md`
- Changes take effect on next container spawn (no restart needed for persona-only changes)

### Add a Skill to a Bot
1. Create `bots/personas/{bot}/skills/{skill-name}/SKILL.md`
2. Skills are synced to the container on each spawn — no rebuild needed
3. Trigger the skill with the `Skill` tool using the skill name

### Change Message Routing / Trigger Pattern
- Edit `bots/personas/{bot}/CLAUDE.md` or group CLAUDE.md for behavioral changes
- Edit `src/main.ts` `processGroupMessages()` for code-level routing changes
- Trigger patterns are configured via `TRIGGER_PATTERN` in the bot's registered group

## After Code Changes

```bash
cd $INFINICLAW_ROOT && npm run build
# Then restart the affected bot
```

## Important Notes

- **Never edit `/workspace/project/`** — that's the deployed copy, overwritten on restart
- **Edit source in `$INFINICLAW_ROOT/src/`**, then build and restart
- **`.mcp.json` is gitignored** (contains OAuth secrets) — edit in place, don't try to git-add
- **Trailing commas in JSON** cause silent parse failures — always validate
