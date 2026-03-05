# 02 — Threading and Lobes

## Threading

- Every lobe operation runs in a thread, not on the main timeline.
- Typing indicators are always sent, including when the bot is working in a thread.
- Bots with `requiresTrigger` use auto-threading: the triggering message becomes the thread root.

## Lobes

Bots spawn delegate "lobes" for parallel execution:
- `delegate_to_lobe` — delegation with Matrix threading. Supports claude, codex, gemini, and ollama backends.
- `query_local_llm` — quiet one-shot Ollama query for formatting, classification, extraction. No chat output.

Every lobe runs in a Matrix thread. The main brain stays sequential — lobes handle subtasks.

## Interrupt Lobe

When the main container has been running >30 seconds and a new message arrives from the Captain or a callout, the host spawns a **parallel container** (Sonnet, stateless, fire-and-forget) to handle it immediately. The main container keeps running.

This gives two-pronged responsiveness:
1. **Persona-level**: bots delegate long work to lobes so their main brain stays available.
2. **Host-level**: if the main container is busy anyway, the host spawns an interrupt lobe.

## Status Indicators

Three indicator types, all following the no-redaction principle (edit in place, never delete):

| Indicator | Meaning | Live state | Finished state |
|-----------|---------|------------|----------------|
| `⏳` | Bot is processing | `⏳ working (3m)` | `⏳ worked (3m)` |
| `💤` | Bot is waiting for input | `💤 idling (5m)` | `💤 idled (5m)` |
| `⏳` | Bot is resuming session | `⏳ resuming...` | `⏳ resumed (Xs)` |

Indicators are sent as a message, then edited in place with elapsed time. On boot/restart, bots announce themselves with a single-line status: emoji + name + role + room + model + hostname.
