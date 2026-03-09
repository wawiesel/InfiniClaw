# 05 — Brain

The brain is the LLM process running inside the bot's container. It makes the bot intelligent — without it, the bot is just a message relay.

## The Main Brain Is a Long-Lived Process

The main brain is a persistent `claude-code` process inside a running container. It does NOT exit after each message. New messages arrive via IPC into the same conversation — just like a human reading new messages in a chat. The main brain responds as part of its ongoing session.

This means:
- **No container spawn per message.** The container starts once and stays running.
- **Triage is instant.** Reading a new IPC message and deciding "branch or reply" is a normal conversation turn — sub-second, not 8 seconds.
- **Context accumulates.** The main brain remembers prior messages in its session. It doesn't start cold each time.

The host's job is to deliver messages to the running container via IPC, not to spawn new containers.

## Brain Management

Each bot's LLM is configured via env (`BRAIN_MODEL`, `BRAIN_OAUTH_TOKEN` / `BRAIN_API_KEY`). Bots can switch models at runtime via the `set_brain_mode` MCP tool + restart.

**Quota fallback:** When the primary provider returns a quota/credit error, the system automatically falls back to Ollama (local model), rewrites the bot's env file, and notifies the Captain. 10-minute cooldown prevents thrashing.

## Session Continuity

On restart, the agent-runner recovers the most recent session to avoid losing conversation context. The host injects a resume message that includes the bot's current todo list so it picks up where it left off without rediscovering tasks from conversation history.

## Verification

1. **Brain starts** — Container spawns, `claude-code` process launches.
   *Check:* Container log shows "Time to first output" metric.

2. **Responds intelligently** — Send `@Bot what is 2+2?` and get a coherent answer.
   *Check:* Bot posts a response that demonstrates LLM reasoning.

3. **Context persists** — Tell the bot something, then ask about it later in the same session.
   *Check:* Bot remembers the earlier information without being reminded.

4. **Session resume** — Restart the bot (via `!rejoin`), ask about pre-restart context.
   *Check:* Bot has access to prior conversation via session recovery.

5. **Model switching** — Change `BRAIN_MODEL` in env, rejoin.
   *Check:* Bot starts with the new model (visible in startup log).
