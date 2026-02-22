# InfiniClaw Code Review: `src/` Directory

## 1. Architectural Intent: Thin Upstream Fork & Thick Wrapper

Based on your design intent, `external/nanoclaw` serves as a "super thin fork that always applies cleanly", while `src/` (InfiniClaw) optimally builds on top of it by wrapping its logic or inserting plugin/hook calls. 

This correctly acknowledges that **some duplication is expected and acceptable** to avoid muddying the upstream tree.

**Current State Analysis:**
Right now, `src/` acts as a *very* thick wrapper. 
- `src/main.ts` (1,100+ lines) is a near-total fork of the upstream message loop (`index.ts`).
- `src/container-spawn.ts` (600+ lines) heavily forks `container-runner.ts` to inject new mounts and secrets.
- `src/ipc-watcher.ts` (400+ lines) forks the IPC loop to intercept extended message types.

While this adheres to the "wrap it to protect upstream" principle, the level of duplication is currently very high. Any changes pulled from upstream NanoClaw's orchestrator (like new scheduling logic or error handling) have to be manually ported over to the InfiniClaw forks.

---

## 2. File-by-File Analysis (`src/`)

### InfiniClaw Entry Points (The "Thick Wrappers")
*   **`main.ts`**: The core orchestrator. Contains the message loop, Matrix channel initialization (`channels/matrix.ts`), and the `!grant-mount` / `!restart-wksm` overrides. It is highly coupled to `container-spawn.ts` and `ipc-watcher.ts`. It re-implements the message processing flow from NanoClaw's upstream `index.ts`.
*   **`container-spawn.ts`**: A near-total fork of upstream's `container-runner.ts`. It builds Podman arguments but injects InfiniClaw-specific mounts (via `container-mounts.ts`), maps SSL certificates (via `container-secrets.ts`), and resolves `INFINICLAW_ROOT`.
*   **`ipc-watcher.ts`**: A fork of upstream's polling loop. It intercepts custom InfiniClaw IPC task types (e.g., Extended Messages) and delegates standard tasks (`schedule_task`) to upstream.
*   **`service.ts` / `cli.ts`**: Excellent, clean implementation. Provides CLI commands (`start`, `stop`, `chat`, `deployBot`, `syncPersona`) and acts as the administrative backbone for managing bot lifecycles via `launchd`.

### Core InfiniClaw Modules
*   **`container-mounts.ts` & `container-secrets.ts`**: Clean separation of concerns. They handle the complex logic of assembling volume mounts based on `container-config.json` and rewriting paths for secrets before they are passed into `container-spawn.ts`.
*   **`ipc-commands.ts`**: Very clean abstraction mapping IPC drops to actual bot behaviors (`restart_bot`, `set_brain_mode`, etc.).
*   **`brain-management.ts`**: Handles the logic for dynamic model selection (`ANTHROPIC_MODEL`, etc.) when responding to IPC commands. It correctly modifies `.claude/settings.json` to trigger hot-reloads within the Claude Agent.
*   **`mcp-sync.ts` & `skill-sync.ts`**: These handle the bidirectional sync of MCP servers and one-way sync of skills. They are well-isolated and invoked during the `service.ts deployBot` lifecycle.
*   **`status.ts` & `status-cli.ts`**: Handles generating and rendering bot status overviews. 

---

## 3. Code Quality & Coupling

**Strengths:**
- **Module Isolation**: The feature-specific modules (`skill-sync.ts`, `brain-management.ts`, `container-secrets.ts`) are well-scoped and easy to test.
- **Security Posture**: The strict checking of `mount-allowlist.json` before passing arguments to Podman is robust.

**Weaknesses (Technical Debt):**
- **Duplication in `main.ts` and `container-spawn.ts`**: Because these files fork upstream logic instead of composing it, any bug fixes or improvements in NanoClaw's `task-scheduler.ts` or upstream `index.ts` message loop have to be manually ported over. For instance, `main.ts` manually manages `activeReplyThreadIds`, duplicating Matrix-specific thread logic inside the generic loop.
- **Config Sprawl**: `main.ts` directly reads `process.env` and `.env.local` in several places rather than relying on a unified `config.ts` module, making environment dependencies harder to track.

## 4. Recommendations / Next Steps

**Rebuttal Update:** After discussing with the Captain, the "thin fork + plugin hooks" strategy has been strategically rejected for the core message loop (`index.ts`) and container runner (`container-runner.ts`).
While adding `onMessageReceived` or `onConfigBuild` hooks to `external/nanoclaw` seems clean, it would introduce fragile interface coupling and make subtree pulls harder. Since upstream NanoClaw changes infrequently, the current "thick wrapper" approach (forking the loop and rewriting bits directly) is actually the correct design choice for this scale.

The sole actionable architectural improvement is to deduplicate the hardcoded custom shell commands from the main orchestrator loop:

1. **Extract Matrix Operator Commands:** The `!grant-mount`, `!revoke-mount`, and `!restart-wksm` commands should be extracted from `main.ts` into a dedicated `src/operator-commands.ts` module. This removes ~50 lines of unrelated capability mapping from the core loop without adding architectural risk.
