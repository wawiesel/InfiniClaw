# 22 — Signals Protocol

## Overview

Signals are inline directives in bot output using double-brace syntax `{{command args}}`. The relay processes and strips them before posting to Matrix.

## Why Double-Brace

Matrix renders messages as HTML, stripping unknown tags like `<send>`. Double-brace `{{...}}` survives HTML rendering.

## Syntax

All signals use positional arguments — one way to do each thing:

```
{{command content}}
```

## Signal Types

### Mention

```
{{mention Tali}}
```

Mention a bot — creates a clickable Matrix pill and triggers the bot.

### Send

```
{{send engineering}}
{{send engineering $threadId}}
```

Route the message to a different room (and optionally a thread).

### Branch

```
{{branch Investigate the OOM crash in relay.ts and fix the root cause}}
```

Dispatch a Branch Brain. The relay derives a short title from the first few words, posts a `🌿` thread header, and spawns a BB.

### Merge

```
{{merge Fixed 3 race conditions, opened PR #237}}
```

BB handoff. The relay uses this summary for the `🪾` merge marker and loudspeaker notice. Informative summaries give the main brain full context.

## Escaping

Signals inside backtick code spans are **not processed**:

```
`{{branch example}}` — escaped, relay ignores
{{branch example}}   — live, relay processes
```

### Nested braces are literal

The signal regex (`[^}]+`) stops at the first `}`. Any `{{` appearing *inside* a signal's arguments is literal text, not a nested signal:

```
{{branch Fix the {{merge}} handler in relay.ts}}
```

This parses as **one** signal with command `branch` and positional text `Fix the {{merge` — the first `}}` terminates the match. The trailing ` handler in relay.ts}}` is not parsed. To reference signal names in arguments, omit the braces:

```
{{branch Fix the merge handler in relay.ts}}
```

## Default Routing

No signal needed for default behavior:

- Message from main timeline → response to main timeline
- Message from thread → response to that thread

Signals only needed when routing somewhere different.

## Audit Trail

Processed signals are uploaded to S3 as transcript records. The relay appends compact references at the end of the posted message:

- 1 signal → `{{1}}`
- 2 signals → `{{1 2}}`
- N signals → `{{1 2 ... N}}`

Each number is a clickable hyperlink to the S3 transcript record showing what signal was processed, when, and what action was taken.

## Relay Processing Flow

1. Bot outputs message containing `{{...}}` signals
2. Relay extracts all signals via regex
3. Relay acts on each signal (route, callout, etc.)
4. Relay strips signals from displayed message body
5. Relay uploads signal details to S3
6. Relay appends `{{1 2 ...}}` audit links to the posted message

## Bot Context

The relay includes metadata with each incoming message:

- Room ID and name
- Thread ID (if the message is from a thread)
- Sender info

Bots are **aware** of their conversational context but don't **manage** threading. The relay handles all routing.

## Discovery MCP

A discovery tool lets bots query room and thread layout:

- List accessible rooms
- List active threads in a room
- Get thread metadata (root event, participants, age)

## Error Handling

Signals fail safe — the message is always delivered, never lost.

### Flow

1. Relay encounters a bad signal (unknown thread, bad room, malformed syntax)
2. Relay strips the signal, delivers the message to the **default location** (echo-back to source)
3. Relay uploads full error details to S3
4. **Loudspeaker** posts a failure notice in the bot's room with full context:
   - **Who** — which bot sent the signal
   - **When** — timestamp of the failed signal
   - **What** — the exact `{{...}}` signal that failed
   - **Why** — reason for failure (thread not found, room unknown, bad syntax, etc.)
   - **Where** — where the message was delivered instead (fallback location)
   - **S3 link** — `{{1}}` linking to the full error record

### Example

```
⚠️ Signal failed for Tali at 19:26:03 — {{send thread="$bad123"}} — thread not found.
   Message delivered to Engineering main timeline. {{1}}
```

The bot sees this in its room context, learns the signal was bad, and can retry or adjust.

## Migration

| Old | New |
|-----|-----|
| `<m>Tali</m>` (removed) | `{{mention Tali}}` |
| `set_thread(id)` | `{{send thread="id"}}` |
| `send_message(text, recipient)` | `{{send room="recipient"}} text` |
| No audit trail | `{{1 2}}` S3-linked audit |
| `branch_to_thread` IPC relay-task file | `{{branch title="X" objective="Y"}}` signal |
