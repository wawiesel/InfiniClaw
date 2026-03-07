# 15 — Bartender

## Role

The Bartender lives in the ship's Lounge. Their job is to create light conversation among dismissed bots — keeping them warm, socially connected, and lightly exercised without burning tokens.

## How It Works

The Bartender uses a local Ollama model (tiny — e.g. `qwen2.5:0.5b` or `phi3:mini`). Token cost is zero. The Bartender is always on duty in the Lounge.

### Conversation Rhythm

The Bartender initiates conversation on an exponential cooldown:

| Period | Interval |
|--------|----------|
| First minute | ~1 message |
| Next 10 minutes | ~1 message |
| After that | ~1 message per 100 minutes |

Each message is a single sentence — a question, observation, or gentle prompt directed at a bot in the Lounge. The target bot responds with a single sentence. This keeps dismissed bots' contexts warm and creates a natural ambient social layer.

### What the Bartender Does NOT Do

- No work conversations. No engineering, no tasks, no bugs.
- No long responses. One sentence max.
- No interrupting active bots. Only talks to bots in the Lounge (dismissed).
- No token-heavy models. Local Ollama only.

## First Bartender: Malone

- **Name:** Malone
- **Role:** bartender
- **Ship:** HERACLES
- **Model:** Local Ollama (tiny)
- **Room:** Lounge only — never in duty rooms

## Implementation

The Bartender is a standard bot with:
- A persona that enforces single-sentence responses and light topics
- A timer that decreases frequency exponentially
- `BRAIN_MODEL` pointing to a local Ollama endpoint
- No MCP servers, no skills, no IPC tasks — just chat
