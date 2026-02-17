# Git History Rewrite Plan

## Goal
Rewrite the post-subtree commits on main into clean, logical, independently understandable commits. Each commit should represent a coherent unit of change.

## Current State
- `main` has 2 monolithic post-subtree commits plus config changes
- `aqua` and `bingo` are squashed snapshots (safety nets)
- Subtree merge point: `a89d41c`

## Challenge
The changes are deeply interconnected:
- `env.ts`, `container-runtime.ts`, `cross-bot.ts`, `ipc-extensions.ts` were deleted
- Their functionality was absorbed into `config.ts`, `index.ts`, `ipc.ts`, `service.ts`
- You can't remove the old modules without updating all consumers atomically
- `service.ts` and `skill-sync.ts` are entirely new modules
- `index.ts` has ~1000 lines of changes touching nearly every function

## Proposed Commit Sequence

### 1. cleanup: remove upstream artifacts
- Delete CID.md, repo-tokens/, GitHub Actions, marketing assets, sample groups
- Consolidate setup skill scripts into single SKILL.md
- **Independent** — no code changes, safe to apply first

### 2. refactor: simplify config and remove env.ts
- Remove `env.ts` dependency from config.ts
- Hardcode `CONTAINER_RUNTIME` to podman
- Reorder config exports
- **Requires**: updating any file that imported from env.ts

### 3. feat: add service.ts CLI module
- New module: service.ts (start/stop/deploy/chat commands)
- New module: cli.ts (entry point)
- New module: skill-sync.ts (persona skill management)
- **Requires**: config changes from step 2

### 4. refactor: consolidate container runtime and cross-bot into core
- Delete container-runtime.ts, cross-bot.ts, ipc-extensions.ts
- Absorb functionality into container-runner.ts, index.ts, ipc.ts
- **Requires**: steps 2-3, and is tightly coupled with index.ts changes

### 5. feat: channel improvements
- Matrix presence, reconnection, formatting
- WhatsApp changes
- **Partially independent** — some changes depend on config.ts updates

### 6. feat: container runner and agent runner enhancements
- Container runner simplification (podman-only)
- Agent runner: lobe delegation (Codex, Gemini, Ollama)
- Agent runner: IPC MCP tools

### 7. feat: mount security with child overrides
- mount-security.ts changes
- mount-allowlist.json

### 8. feat: holodeck blue-green deployment
- service.ts holodeck functions
- ipc.ts holodeck commands
- engineer-dev persona

### 9. feat: resume after restart, nudge suppression
- index.ts: injectResumeMessage, mission context, nudge timer

### 10. chore: InfiniClaw personas, skills, and docs
- bots/ persona files
- docs/
- Commander skills

## Approach
Steps 1 and 10 are straightforward. Steps 2-9 require careful ordering and tsc verification at each step. The main risk is steps 2-4 which are the tightest coupling.

Each step should be verified with `npx tsc --noEmit` before committing.
