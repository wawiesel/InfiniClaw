# 05 — Brain

The brain is the LLM process running inside the bot's container. It makes the bot intelligent — without it, the bot is just a message relay.

## The Main Brain Is a Long-Lived Process

The main brain is a persistent `claude-code` process inside a running container. It does NOT exit after each message. New messages arrive via IPC into the same conversation — just like a human reading new messages in a chat. The main brain responds as part of its ongoing session.

This means:
- **No container spawn per message.** The container starts once and stays running.
- **Triage is instant.** Reading a new IPC message and deciding "branch or reply" is a normal conversation turn — sub-second, not 8 seconds.
- **Context accumulates.** The main brain remembers prior messages in its session. It doesn't start cold each time.

The host's job is to deliver messages to the running container via IPC, not to spawn new containers.

## Message Delivery

Messages flow from Matrix through the host to the container:

```
Matrix event
  → host message loop (polls SQLite every ~100ms)
  → getNewMessages() returns unprocessed messages
  → host writes message to /workspace/ipc/{group}/input/
  → agent-runner inside container reads IPC input
  → delivers message to claude-code as a new conversation turn
```

The database is the source of truth for message ordering. Messages are stored in SQLite with `is_bot_message` flags to prevent echo loops (the bot's own output is stored with `is_bot_message: true` so it's never returned as a "new" message).

## Turn Timeout

The main brain has a hard wall-clock timeout to enforce the dispatch model — triage quickly, delegate complex work.

**Default:** 90 seconds (`MAIN_BRAIN_TURN_TIMEOUT_MS`, configurable per-bot via env).

When the timeout fires:
1. `podman stop` sends SIGTERM to the container (15s grace period)
2. If the container doesn't stop, SIGKILL follows
3. The host flags the turn as killed-by-timeout
4. The bot restarts and resumes via session recovery

`podman stop` is required — not `process.kill('SIGTERM')`. Podman does not relay signals to container processes; only `podman stop` works.

## Brain Configuration

Each bot's LLM is configured via env keys in `secrets/bots/{name}/env`:

| Env key | Maps to (inside container) | Purpose |
|---------|---------------------------|---------|
| `BRAIN_MODEL` | `ANTHROPIC_MODEL` | Model ID |
| `BRAIN_OAUTH_TOKEN` | `CLAUDE_CODE_OAUTH_TOKEN` | OAuth authentication |
| `BRAIN_API_KEY` | `ANTHROPIC_API_KEY` | API key authentication |

The container never sees the raw `BRAIN_*` names — the host maps them during container spawn. This separation keeps bot configuration (secrets repo) decoupled from Claude Code internals (container runtime).

### Model Resolution

Generic model aliases are upgraded to concrete dated model IDs when available. The `brain-management.ts` module tracks model usage from Claude Code session stats and resolves the active model.

### Runtime Model Switching

Bots can switch models at runtime via the `set_brain_mode` IPC command + restart. The relay updates the bot's env file and triggers a rejoin.

## Quota Fallback

When the primary LLM provider returns a quota or credit error, the system automatically falls back to a local Ollama model:

1. `maybeAutoSwitchBrainsOnQuotaError()` detects the quota error
2. All bot env files are rewritten to use Ollama (local model, `http://host.containers.internal:11434`)
3. The Captain is notified
4. 10-minute cooldown prevents thrashing between providers

## Session Continuity

On restart (crash, deploy, or `!wake` restart), the agent-runner recovers the most recent `claude-code` session to avoid losing conversation context:

1. Synthetic resume message injected with the last 10 messages as context
2. Active todo list included so the bot picks up where it left off
3. Trigger patterns stripped from context to prevent false re-activation
4. Container spawns to process the resume message

Configurable delay via `RESUME_DELAY_SECONDS` (default 0).

## Crash Recovery

- pm2 auto-restarts on crash (2s delay, max 100 restarts)
- Exit code 137 (SIGKILL/OOM) triggers backoff cooldown (60s, after 3 consecutive crashes)
- Session state persisted in SQLite survives restarts

## Verification

1. **Brain starts** — Container spawns, `claude-code` process launches.
   *Check:* Container log shows "Time to first output" metric.

2. **Responds intelligently** — Send `<m>Bot</m> what is 2+2?` and get a coherent answer.
   *Check:* Bot posts a response that demonstrates LLM reasoning.

3. **Context persists** — Tell the bot something, then ask about it later in the same session.
   *Check:* Bot remembers the earlier information without being reminded.

4. **Turn timeout enforced** — Bot runs a long task that exceeds the timeout.
   *Check:* Container killed via `podman stop` after `MAIN_BRAIN_TURN_TIMEOUT_MS`. Bot restarts and resumes.

5. **Session resume** — Restart the bot (via `!wake`), ask about pre-restart context.
   *Check:* Bot has access to prior conversation via session recovery.

6. **Model switching** — Change `BRAIN_MODEL` in env, rejoin.
   *Check:* Bot starts with the new model (visible in startup log).

7. **Quota fallback** — Trigger a quota error (or simulate one).
   *Check:* Bot switches to Ollama, Captain notified. Cooldown prevents rapid switching.
