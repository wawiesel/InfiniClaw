# 22 — Signals Protocol

## Overview

Signals are inline directives in bot output using double-brace syntax `{{command args}}`. The relay processes and strips them before posting to Matrix.

## Why Double-Brace

Matrix renders messages as HTML, stripping unknown tags like `<send>`. Double-brace `{{...}}` survives HTML rendering.

## Syntax

```
{{command key="value"}}
```

## Signal Types

### Callout

```
{{m Tali}}
```

Notify a specific bot. Replaces `<m>Tali</m>`.

### Route

```
{{send room="engineering"}}
{{send thread="$eventId"}}
{{send room="engineering" thread="$eventId"}}
```

Route the message to a specific room and/or thread.

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
| `<m>Tali</m>` | `{{m Tali}}` |
| `set_thread(id)` | `{{send thread="id"}}` |
| `send_message(text, recipient)` | `{{send room="recipient"}} text` |
| No audit trail | `{{1 2}}` S3-linked audit |
