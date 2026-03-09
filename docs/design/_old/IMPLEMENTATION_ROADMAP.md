# Roadmap: Branch and Merge Architecture

This document provides the technical specification for implementing the "Branch and Merge" threading model. The goal is to move from destructive `SIGTERM` interrupts to non-blocking, parallel execution of tasks in threads.

## Phase 1: The Main Brain (Triage)

The Main Brain is the primary `claude-code` process. It must never be blocked.

### Code Changes: `src/main.ts`
1.  **Remove SIGTERM Logic:** Remove `sendInterruptMessage` and the `SIGTERM` trigger in `handlePipedToActiveContainer`.
2.  **Implement IPC Message Queueing:** Modify `handlePipedToActiveContainer` to simply write a `message-<ts>.json` to the IPC input directory. The Main Brain should return control to the host loop immediately.
3.  **Short Turn Enforcements:** Inject a system instruction to the Main Brain: "You are a Triage Agent. If a task takes >2 seconds, use the `branch_to_thread` tool. Never execute complex bash or file tasks in the Main Brain."

## Phase 2: Thread Brains (Execution)

Thread Brains are parallel `claude-code` processes spawned *inside* the same container.

### Code Changes: `external/nanoclaw/container/agent-runner/src/delegate-runner.ts`
1.  **Create `branch_to_thread` Tool:**
    - Input: `objective`, `thread_id`.
    - Action: Spawns a new `claude` child process.
    - Configuration: Uses `--resume --thread-id <id>`.
    - Async: The tool should return `{"status": "Branch created"}` immediately, allowing the Main Brain to end its turn.
2.  **Immortal Context (Hydration):**
    - Ensure that when a Thread Brain spawns, it has access to the Matrix history for that thread. 
    - The host process (`src/main.ts`) must fetch thread history from the SQLite database and inject it into the `ContainerInput`.

## Phase 3: Async Lobes (Workers)

Lobes are fast, stateless workers spawned *by* a Thread Brain.

### Code Changes: `external/nanoclaw/container/agent-runner/src/delegate-runner.ts`
1.  **Modify `delegate_to_lobe`:** Change it from synchronous (blocking) to asynchronous (fire-and-forget).
2.  **Callback Mechanism:** When a Lobe child process exits, it must write a `result-<ts>.json` to the Thread Brain's IPC input directory. 
3.  **Notification:** The `agent-runner` must inject a system message into the Thread Brain's next turn: `[System] Lobe <id> finished. Result: ...`

## Phase 4: The Merge (State Reconciliation)

The final step is reconcile the branch work back to the trunk.

### Tactical Changes
1.  **MEMORY.md Update:** Instruct Thread Brains to always use the `save_memory` tool before finishing.
2.  **Completion Signal:** When a Thread Brain finishes, it writes a `merge_request` IPC file.
3.  **Reporting:** The host process sees the `merge_request` and injects a notification to the Main Brain: `[System] Thread <id> merged. Update the Captain on the main timeline.`

## Verification
- Dropping a message while a bot is working should trigger an immediate response from the Main Brain (2 seconds).
- The bot should be able to maintain multiple active threads simultaneously without context corruption.
- Thread history must survive container restarts.
