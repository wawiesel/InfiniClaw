# 02 — Threading and Lobes

## The Branch and Merge Architecture

InfiniClaw uses a "Branch and Merge" threading model. The main brain stays responsive on the main timeline. Complex work happens in visible Matrix threads.

### 1. The Main Brain (The Trunk)

A persistent, long-lived `claude-code` process inside the container. It does NOT restart per message — it stays running and receives new messages via IPC as conversation turns.

- **Responsibility:** Read new messages, reply to simple ones, branch complex ones.
- **Responsiveness:** A triage decision is a normal conversation turn — sub-second. The main brain never does heavy work itself.
- **Action:** For complex requests, calls `branch_to_thread(objective)`. This tells the host to create a visible thread and spawn a Thread Brain. The main brain immediately continues listening.

### 2. The Thread Brain (The Branch)

A separate container process spawned by the host, wired to post into a specific Matrix thread.

- **Visibility:** The host creates a thread on the main timeline BEFORE spawning the Thread Brain. The thread is visible to the Captain immediately.
- **Output:** Every `send_message` from the Thread Brain posts into that thread. Tool calls, progress, questions, results — all visible in the thread.
- **Interaction:** The Captain can reply in the thread. The Thread Brain sees replies and responds within the thread.
- **Collaboration:** The CO's Thread Brain can tag other bots (e.g., `@Cid`). The tagged bot's main brain sees this and spawns its own Thread Brain in the same thread.

### 3. Async Lobes (The Workers)

Single-purpose worker processes spawned by a Thread Brain for heavy lifting (e.g., Codex for edits, Gemini for review).

- Run asynchronously — the Thread Brain is not blocked while waiting.
- Results are written to a callback file. The Thread Brain picks them up and posts findings to the thread.
- Lobes do NOT post to Matrix directly. The Thread Brain is responsible for reporting lobe results to the Captain.

### The Merge

When a Thread Brain completes its task:

1. **Memory Update:** Write learnings to `MEMORY.md` via `save_memory`.
2. **Thread Summary:** Post a completion message in the thread.
3. **Main Timeline Summary:** Post a one-line summary to the main timeline so the Captain sees the outcome without clicking into the thread.
4. **Termination:** Thread Brain exits. The thread remains in Matrix history permanently.

### Thread Reactivation (Immortal Context)

Matrix thread history is permanent. Thread Brains are ephemeral — they exit after completing their task. But the thread context is immortal.

If the Captain asks a follow-up in a completed thread days later:
1. The host detects the thread and the bot's previous participation.
2. The host spawns a new Thread Brain, hydrated with the thread's history from SQLite.
3. The Thread Brain answers the question in the thread and exits.

## Presence

Bots feel like humans. Silence means idle. Messages mean working. No status indicator messages.

The only presence signal is the **pip** on the display name:

| Pip | Meaning |
|-----|---------|
| 🟢 | Alive — bot is running and responsive |
| 💤 | Idle — no activity for `IDLE_PIP_THRESHOLD_MS` (default 5 min) |
| 🔴 | Offline — bot is stopped or dismissed |

The pip resets to 🟢 on any message processing.
