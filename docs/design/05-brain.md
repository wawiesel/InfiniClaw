# 05 — Brain

The brain is a persistent `claude-code` process inside a bot's container. It does NOT exit after each message — new messages arrive via IPC into the same ongoing conversation.

## Persistent Session

The main brain starts once and stays running. Messages arrive like a human reading chat — the brain triages each one as a normal conversation turn.

This means:
- **Triage is instant.** Reading a new message and deciding "branch or reply" is sub-second, not a cold start.
- **Context accumulates.** The brain remembers prior messages in its session without being reminded.
- **The host delivers, the brain decides.** The host writes incoming messages to the container via IPC (see [06-ipc](06-ipc.md)). The brain reads them and acts.

## Triage and Delegate

The brain's job on each turn is simple: read the message, respond or delegate.

- **Simple:** reply directly in the conversation.
- **Complex:** call `branch_to_thread` to spawn a Thread Brain (see [07-threading](07-threading.md)), then continue listening. The main brain never blocks on complex work.

The turn timeout enforces this model — if the brain takes too long, the container is killed via `podman stop` and the bot resumes via session recovery (see [04-bot](04-bot.md)). Default timeout is configurable per-bot via `MAIN_BRAIN_TURN_TIMEOUT_MS` env.

## Credential Mapping

Each bot's LLM is configured via env keys in `secrets/bots/{name}/env`:

| Env key | Maps to (inside container) | Purpose |
|---------|---------------------------|---------|
| `BRAIN_MODEL` | `ANTHROPIC_MODEL` | Model ID |
| `BRAIN_OAUTH_TOKEN` | `CLAUDE_CODE_OAUTH_TOKEN` | OAuth authentication |
| `BRAIN_API_KEY` | `ANTHROPIC_API_KEY` | API key authentication |

The container never sees the raw `BRAIN_*` names — the host maps them during container spawn. This keeps bot configuration (secrets repo) decoupled from Claude Code internals (container runtime). Bots can switch models at runtime via the `set_brain_mode` IPC command + wake.

## Verification

1. **Brain starts** — Container spawns, `claude-code` process launches.
   *Check:* Container log shows "Time to first output" metric.

2. **Responds intelligently** — Send `<m>Bot</m> what is 2+2?` and get a coherent answer.
   *Check:* Bot posts a response that demonstrates LLM reasoning.

3. **Context persists** — Tell the bot something, then ask about it later in the same session.
   *Check:* Bot remembers the earlier information without being reminded.

4. **Triage speed** — Send a message to an idle bot.
   *Check:* Response begins within seconds, not a cold-start delay.

5. **Delegation works** — Give the bot a complex task.
   *Check:* Bot calls `branch_to_thread`, Thread Brain spawns, main brain remains responsive.
