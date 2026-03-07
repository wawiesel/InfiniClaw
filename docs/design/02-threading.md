# 02 — Threading and Lobes

## The Branch and Merge Architecture

InfiniClaw operates on a strict "Branch and Merge" threading model, designed to mirror how engineering teams use git. The goal is to provide **instant responsiveness** to the Captain on the main timeline while complex, multi-step work happens asynchronously in threads.

### Process Topology

Each bot container runs a hierarchy of processes, ensuring the bot is never blocked or forced into a destructive restart (`SIGTERM`).

#### 1. The Main Brain (The Trunk)
- The primary, always-on `claude-code` process.
- **Responsibility:** Triage, delegation, and reporting. It listens *only* to the main timeline and direct high-priority system messages.
- **Responsiveness:** It must process and return control within 2–5 seconds. It never performs heavy API calls or file parsing.
- **Action:** When a complex request arrives, the Main Brain uses the `branch_to_thread` tool. This spawns a separate Thread Brain, allowing the Main Brain to immediately return to "minding the store" (listening for new main timeline messages).

#### 2. The Thread Brain (The Branch)
- A secondary, ephemeral `claude-code` process spawned by the Main Brain, locked to a specific Matrix `thread_id`.
- **Responsibility:** Executing the actual task, collaborating with other bots, and interacting with the Captain *inside* that specific thread.
- **Collaboration:** A CO's Thread Brain will tag a non-CO bot in the thread (e.g., `@Cid`). The non-CO's Main Brain sees this and spawns its *own* Thread Brain to do the work. They collaborate entirely within the thread.

#### 3. Async Lobes (The Workers)
- Fast, single-purpose worker processes (e.g., `codex` for file edits, `grep` for searching) spawned by a Thread Brain using `spawn_async_lobe`.
- **Responsibility:** Heavy lifting. They run asynchronously, reporting their results back to the Thread Brain's input queue when finished. The Thread Brain is not blocked while waiting for them.

### The Merge (State Reconciliation)

When a task is complete, it must be "Merged" back to the Main Brain.

1.  **Memory Update:** Both the CO and non-CO Thread Brains use the `save_memory` tool to write their learnings and state to their respective `MEMORY.md` files. This ensures persistence across container restarts.
2.  **Termination:** The Thread Brains compile a final summary, send a "Task Complete" system signal to their Main Brains, and cleanly terminate to free up memory.
3.  **Reporting:** The CO's Main Brain reads the updated `MEMORY.md` and posts a final, unified summary to the Captain on the main timeline.

### Thread Reactivation (Immortal Context)

Matrix thread history is permanent. While Thread Brains are ephemeral (they die after the Merge to save memory), the **Thread Context is immortal**.

If the Captain asks a follow-up question in a "Merged" thread days later:
1.  InfiniClaw's router detects the `thread_id` and the bots' previous participation.
2.  The Main Brain instantly spawns a *new* Thread Brain.
3.  InfiniClaw automatically queries the local SQLite database, hydrates the new Thread Brain with the historical context of that specific thread, and the bot answers the question seamlessly before terminating again.

## Status Indicators

Three indicator types, all following the no-redaction principle (edit in place, never delete):

| Indicator | Meaning | Live state | Finished state |
|-----------|---------|------------|----------------|
| `⏳` | Thread Brain / Lobe is processing | `⏳ working (3m)` | `⏳ worked (3m)` |
| `💤` | Main Brain is waiting for input | `💤 idling (5m)` | `💤 idled (5m)` |
| `⏳` | Bot is resuming session | `⏳ resuming...` | `⏳ resumed (Xs)` |
