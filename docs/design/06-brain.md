# 06 — Brain

Every bot has up to three types of brain process. Each serves a different purpose and runs in a different context.

| Type | Engine | Where it posts | Initiated by | Can branch? | Can lobe? |
|------|--------|---------------|--------------|-------------|-----------|
| **Main** | claude-code (persistent) | Current room main timeline | Always running | Yes | Yes |
| **Branch** | claude-code (fork-session) | Thread in current room | Main brain | No | Yes |
| **Lobe** | Arbitrary (MCP) | Thread in quarters | Main or branch | No | No |

## Main Brain

A persistent `claude-code` session inside the bot's container. It does not exit after each message — new messages arrive via IPC into the same ongoing conversation (see [07-ipc](07-ipc.md)).

- **Triage is instant.** Reading a new message and deciding "branch or reply" is sub-second.
- **Context accumulates.** The brain remembers prior messages in its session.
- **Never blocks.** Complex work is branched or lobed, never done inline.

The turn timeout enforces this model — if the brain takes too long, the container is killed via `podman stop` and the bot resumes via session recovery (see [05-bot](05-bot.md)).

## Branch Brain

An interactive `claude` process that forks from the main brain's session and works in a visible Matrix thread in the bot's current room. The bot itself initiates a branch when a request is too complex for inline triage.

- **Bot-driven spawn** — the bot calls `branch_to_thread(title, purpose, duration, room_id)`. The tool posts the `🌿 title — purpose` thread header automatically. The relay does not announce or spawn branches.
- **Forks main brain context** — uses `--continue --fork-session` to inherit the main brain's conversation history at branch start.
- **Interactive** — while running, the branch can converse normally in-thread.
- **Main timeline injection** — all main timeline messages (main brain, Captain, other bots) are injected into any live branch so the branch keeps main-context awareness.
- **Model selection** — the bot chooses from its configured branch models (e.g. main=haiku, branch=[haiku, sonnet]).
- **No nested branching** — a branch brain should not branch again (enforced by prompt instruction; see issue #25 for programmatic enforcement).
- **Delayed main assimilation** — the main brain does not receive thread context while the branch is running.
- **Merge closes thread** — when work completes, the branch posts a merge marker (`🪾`) at thread end, injects its final summary into main brain history, and the thread becomes closed. New posts in that thread receive a loudspeaker "thread is closed" response.
- **Streaming output** — assistant output is posted into the thread as it arrives, so the Captain can follow progress in real-time.

See [08-threading](08-threading.md) for the branching protocol and implementation.

## Lobe Brain

> **Status:** Lobe infrastructure exists (`delegate_to_lobe` tool, `delegate-runner.ts`) but the full end-to-end workflow (quarters thread posting, completion notifications, bot pickup) is not yet production-ready.

An MCP tool that spawns a non-blocking worker using any provider. The lobe does not receive the full conversation context — only what the bot explicitly passes.

- **Posts to quarters** — lobe progress appears in a thread in the bot's quarters room via loudspeaker, regardless of which room the bot is currently in.
- **Completion notification** — when the lobe finishes, it posts a summary to the quarters main timeline. The bot picks this up automatically if active.
- **Any provider** — gemini, codex, ollama, claude. The bot develops its own heuristics for when to use which.
- **Both main and branch can lobe** — either brain type can invoke a lobe.

The bot can use Matrix navigation tools (see [02-matrix](02-matrix.md)) to fetch the lobe thread and investigate results further.

## Configuration

> **Status:** Per-task model selection from persona/memory is not yet implemented. Branch brains receive the bot's `BRAIN_MODEL` forwarded as `ANTHROPIC_MODEL` via `mapBrainEnv()` (issue #24 fixed). Dynamic model selection per task is still planned.

Brain preferences live in the bot's **persona and memory** — not in fleet.json or env files. The bot chooses its branch model at branch time based on the task. Over time, the bot develops guidance on which models work best for which tasks.

## Credential Mapping

Each bot's LLM is configured via env keys in `secrets/bots/{name}/env`:

| Env key | Maps to (inside container) | Purpose |
|---------|---------------------------|---------|
| `BRAIN_MODEL` | `ANTHROPIC_MODEL` | Model ID — forwarded to both main brain container and branch brains via `mapBrainEnv()` (issue #24 fixed) |
| `BRAIN_OAUTH_TOKEN` | `CLAUDE_CODE_OAUTH_TOKEN` | OAuth authentication |
| `BRAIN_API_KEY` | `ANTHROPIC_API_KEY` | API key authentication |

The container never sees the raw `BRAIN_*` names — the host maps them in the pm2 startup script before the bot process runs. This keeps bot configuration (secrets repo) decoupled from Claude Code internals.

## Verification

1. **Main brain starts** — Container spawns, `claude-code` process launches.
   *Check:* Container log shows "Time to first output" metric.

2. **Triage speed** — Send a message to an idle bot.
   *Check:* Response begins within seconds, not a cold-start delay.

3. **Context persists** — Tell the bot something, ask about it later in the same session.
   *Check:* Bot remembers without being reminded.

4. **Branch works** — Give the bot a complex task.
   *Check:* Thread appears in current room, branch brain streams output, main brain stays responsive.

5. **Lobe works** — Bot delegates to a lobe.
   *Check:* Thread appears in quarters. Summary posted to quarters timeline on completion.

6. **No nested branching** — Branch brain attempts to branch.
   *Check:* Branch is rejected or not offered.
