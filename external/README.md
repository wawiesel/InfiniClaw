# external/

Upstream dependencies, vendored as source.

## nanoclaw/

Fork of [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw) stripped down to a pure TypeScript library. InfiniClaw imports nanoclaw's `.ts` source for core infrastructure (database, container runner, IPC, message routing, configuration) via npm workspaces.

**What we keep:** `src/`, `dist/`, `package.json`, `tsconfig.json`, `vitest.config.ts` — the TypeScript library and its build config.

**What we delete:** CLAUDE.md, skills, skills-engine, MCP config, container definitions, setup wizards, docs, launchd plists, CI workflows, and all other non-code artifacts. InfiniClaw owns all of these concerns independently:

- Instructions: `bots/CLAUDE.md` + `bots/{role}/{bot}/CLAUDE.md`
- Skills: `bots/skills/`
- MCP: `bots/{role}/mcp.json` + `src/mcp-sync.ts`
- Containers: `bots/{role}/{bot}/Dockerfile` + `bots/build.sh`

**Upstream remote:** `nanoclaw` → `https://github.com/qwibitai/nanoclaw.git`

**Pulling upstream:**
```bash
git fetch nanoclaw
git diff HEAD..nanoclaw/main -- external/nanoclaw/src/ external/nanoclaw/package.json
# Review, then subtree merge or cherry-pick src/ changes only
git checkout nanoclaw/main -- external/nanoclaw/src/ external/nanoclaw/package.json
# Delete anything that crept back in outside src/
git checkout HEAD -- external/nanoclaw/.gitignore external/nanoclaw/tsconfig.json external/nanoclaw/vitest.config.ts
```

Only merge `src/` and `package.json`. Discard everything else. The fork should never re-accumulate non-library files.

**After pulling upstream:**
1. Rebuild dist: `cd external/nanoclaw && npx tsc`
2. Check InfiniClaw build: `npx tsc --noEmit` from repo root
3. If upstream removed functions InfiniClaw uses, move them into `src/` (see `nanoclaw-ext.d.ts`, `db-ext.ts`, etc.)
4. Run tests: `npx vitest run`
