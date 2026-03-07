# 05 — Commanding Officer

Each room has a **Commanding Officer (CO)** — the lowest-rank active bot in that room. The CO acts as the primary orchestrator, triage agent, and reviewer for the room.

## The Manager Role

In the **Branch and Merge** architecture, the CO's Main Brain acts as a manager:
1.  **Fielding:** It responds instantly (within 2 seconds) to unaddressed messages on the main timeline.
2.  **Branching:** If a request requires significant work, the CO uses the `branch_to_thread` tool to create a task-specific Thread Brain.
3.  **Delegation:** In the thread, the CO pings other bots (e.g., `@Cid`) to perform the work.
4.  **Reviewing:** The CO's Thread Brain interacts with the non-CO bot in the thread, reviewing findings and approving code changes.
5.  **Merging:** Once approved, the CO merges the task outcome into `MEMORY.md` and posts a final summary to the Captain on the main timeline.

## CO Election

CO is determined from `fleet.json` at startup and updated at runtime via relay lifecycle messages. 

### Startup
Each bot reads the `IS_CO` environment variable (injected by the host based on `fleet.json`) to set its initial badge. Display name badges: ⭐ = CO, 🟢 = active, 🔴 = dismissed/offline.

### Runtime Updates
When the relay dismisses or joins a bot, it posts a lifecycle message via intercom (e.g., `HERACLES: Cid stopped`). All bots parse these messages to update their in-memory `roomRoster` and re-evaluate who holds the CO role.

## Responsiveness

The CO's Main Brain is **non-blocking**. It never performs heavy tasks. If only the CO is available, it still branches to a Thread Brain to do the work, ensuring the Main Brain is always ready to field the next message from the Captain.
