# external/

Upstream dependencies, vendored as source.

## nanoclaw/

Fork of [NanoClaw](https://github.com/nicobailon/NanoClaw) stripped down to a pure TypeScript library. InfiniClaw imports nanoclaw's `.ts` source for core infrastructure (database, container runner, IPC, message routing, configuration) via npm workspaces.

**What we keep:** `src/`, `dist/`, `package.json`, `tsconfig.json`, `vitest.config.ts` — the TypeScript library and its build config.

**What we delete:** CLAUDE.md, skills, skills-engine, MCP config, container definitions, setup wizards, docs, launchd plists, CI workflows, and all other non-code artifacts. InfiniClaw owns all of these concerns independently:

- Instructions: `bots/CLAUDE.md` + `bots/{role}/{bot}/CLAUDE.md`
- Skills: `bots/skills/`
- MCP: `bots/{role}/mcp.json` + `src/mcp-sync.ts`
- Containers: `bots/{role}/{bot}/Dockerfile` + `bots/build.sh`

**Merging upstream:** When pulling changes from upstream nanoclaw, only merge `src/` and `package.json`. Discard everything else. The fork should never re-accumulate non-library files.
