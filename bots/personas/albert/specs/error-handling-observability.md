# Engineering Spec: Error Handling & Observability

**Version:** 1.0
**Author:** Architect
**Date:** 2026-02-26
**Status:** Draft for Implementation

---

## Summary

This spec proposes two critical improvements to InfiniClaw's operational reliability:

1. **Consistent Error Handling** — Standardize error handling across IPC command handlers to eliminate silent failures and ensure users receive feedback when operations fail
2. **Lightweight Observability** — Add trace IDs, structured event logging, and latency tracking to enable debugging and performance analysis without external dependencies

These changes target `/Users/ww5/2026-Nanoclaw/InfiniClaw/src/ipc-commands.ts` and `/Users/ww5/2026-Nanoclaw/InfiniClaw/src/chat-activity.ts`, with minimal additions to the logging and types infrastructure.

---

## Motivation

### Why Now

**Error Handling Problems:**
- **Silent failures** — 10+ handlers use empty `catch {}` blocks (lines 290, 302, 330, 325), hiding operational failures from both logs and users
- **Inconsistent user feedback** — Some handlers notify users on error (`handleStopBot` line 410), others don't (`handleSetBrainMode` line 268)
- **Lost context** — When errors occur, we don't know which bot, which command, or which room triggered the failure
- **No failure visibility** — IPC commands can fail silently, leaving users waiting indefinitely with no indication something went wrong

**Observability Gaps:**
- **No correlation** — When debugging a failed container run, we can't correlate log lines across the lifecycle (message received → container started → IPC command → container finished)
- **No latency data** — We track `runStartedAt` in `chat-activity.ts` (line 124) but never compute or log elapsed time
- **No trend analysis** — Can't answer "Are containers getting slower?" or "Which commands fail most often?"
- **Manual health checks** — No programmatic way to detect degradation patterns

These issues compound during incident response. When a bot fails to restart or a holodeck creation silently fails, debugging requires manual log correlation and guesswork.

---

## Scope

### In Scope

**Part 1: Error Handling**
- Standardize error handling pattern across all IPC command handlers in `ipc-commands.ts`
- Create shared error handling utility function
- Ensure all errors are logged with structured context
- Ensure all errors (when `chatJid` present) send user-visible feedback
- Document acceptable error patterns

**Part 2: Observability**
- Add trace ID generation and propagation through container lifecycle
- Add structured event logging at key lifecycle points
- Compute and log latency for container runs
- Write lightweight metrics to local NDJSON file (`_runtime/data/metrics.jsonl`)
- Keep implementation simple (no external services, no Prometheus)

### Out of Scope

- Metrics aggregation UI or dashboard (metrics file is append-only for external tooling)
- Distributed tracing (single-node system, file-local trace IDs sufficient)
- Real-time alerting (future work)
- Performance optimization of existing code (focused on visibility, not speed)
- Changes to NanoClaw base library (all changes in InfiniClaw layer)

---

## Detailed Design

### Part 1: Error Handling Standardization

#### Problem Analysis

Current state across `ipc-commands.ts` handlers:

| Handler | Line | Error Pattern | Issue |
|---------|------|---------------|-------|
| `handleRestartBot` | 290, 302, 330 | `try { await ctx.sendMessage(...) } catch {}` | Swallows message send failures |
| `handleSetBrainMode` | 268 | `catch (err) { logger.error(...) }` | Logs error but no user feedback |
| `handleStopBot` | 408 | `catch (err) { logger.error(...); if (chatJid) ctx.sendMessage(...) }` | **Good pattern** |
| `handleBotStatus` | 474 | `catch (err) { logger.error(...) }` | Logs but no user feedback |
| `persistChatActivity` (chat-activity.ts) | 57 | `catch { /* Non-critical */ }` | Acceptable (persistence is best-effort) |

#### Design Decision: Three Error Patterns

**Pattern A: Critical Commands** (user-initiated, expect feedback)
```typescript
try {
  // Command logic
} catch (err) {
  handleCommandError(err, chatJid, ctx, 'command_name', { bot, ...extraContext });
}
```

**Pattern B: Best-Effort Operations** (non-critical, acceptable to swallow)
```typescript
try {
  persistChatActivity(chatJid);
} catch {
  // Non-critical - persistence failures don't block command execution
}
```

**Pattern C: Nested Cleanup** (cleanup after main operation)
```typescript
// Main operation
if (chatJid) {
  try {
    await ctx.sendMessage(chatJid, 'Success!');
  } catch (err) {
    logger.warn({ chatJid, err }, 'Failed to send success notification');
    // Don't re-throw - message send failures shouldn't fail the command
  }
}
```

#### New Utility Function

Add to `ipc-commands.ts` after line 184:

```typescript
/**
 * Standard error handler for IPC commands.
 * Logs error with structured context and sends user feedback if chatJid present.
 *
 * @param err - The error that occurred
 * @param chatJid - Optional chat JID to send user feedback
 * @param ctx - IPC context for sending messages
 * @param commandLabel - Short label for the command (e.g., 'restart_bot', 'holodeck_create')
 * @param context - Additional structured context for logging (bot name, branch, etc.)
 */
async function handleCommandError(
  err: unknown,
  chatJid: string | null,
  ctx: InfiniClawIpcContext,
  commandLabel: string,
  context: Record<string, unknown> = {},
): Promise<void> {
  const errorMessage = err instanceof Error ? err.message : String(err);

  // Log with full context
  logger.error(
    {
      command: commandLabel,
      chatJid: chatJid || undefined,
      err,
      ...context,
    },
    `IPC command failed: ${commandLabel}`,
  );

  // Send user feedback if chatJid present
  if (chatJid) {
    try {
      const contextStr = Object.keys(context).length > 0
        ? ` (${Object.entries(context).map(([k, v]) => `${k}: ${v}`).join(', ')})`
        : '';
      await ctx.sendMessage(
        chatJid,
        `⛔ Command failed: ${commandLabel}${contextStr}\n\n\`\`\`\n${truncateOutput(errorMessage, 500)}\n\`\`\``,
      );
    } catch (msgErr) {
      // Don't throw - message send failures shouldn't mask the original error
      logger.warn(
        { chatJid, err: msgErr, originalCommand: commandLabel },
        'Failed to send error notification to user',
      );
    }
  }
}
```

#### Refactoring Plan

**High Priority** (user-facing commands, currently missing feedback):

1. `handleSetBrainMode` (line 258-269)
   - **Current:** Logs error, no user feedback
   - **Change:** Add `handleCommandError(err, chatJid, ctx, 'set_brain_mode', { bot: data.bot, mode: data.mode })`

2. `handleBotStatus` (line 473-475)
   - **Current:** Logs error, no user feedback
   - **Change:** Add `handleCommandError(err, chatJid, ctx, 'bot_status', { bot })`

3. `handleRestartBot` nested catches (lines 290, 302, 330, 325)
   - **Current:** Silent swallow of message send failures
   - **Change:** Apply **Pattern C** — log warning but don't re-throw

**Medium Priority** (already have some error handling, improve consistency):

4. All holodeck handlers (`handleHolodeckCreate` line 595, `handleHolodeckTeardown` line 617, etc.)
   - **Current:** Good pattern but inconsistent error message format
   - **Change:** Standardize to use `handleCommandError` for consistent logging structure

**Example Refactor** — `handleSetBrainMode`:

```typescript
// Before (line 258-269)
try {
  const summary = applyBrainMode(
    data.bot,
    data.mode as 'anthropic' | 'ollama',
    typeof data.model === 'string' ? data.model : undefined,
  );
  logger.info({ bot: data.bot, mode: data.mode }, 'Brain mode updated via IPC');
  const chatJid = parseChatJid(data);
  if (chatJid) await ctx.sendMessage(chatJid, `engineer:\n\n${summary}`);
} catch (err) {
  logger.error({ err, data }, 'Failed to apply set_brain_mode');
}

// After
try {
  const summary = applyBrainMode(
    data.bot,
    data.mode as 'anthropic' | 'ollama',
    typeof data.model === 'string' ? data.model : undefined,
  );
  logger.info({ bot: data.bot, mode: data.mode }, 'Brain mode updated via IPC');
  const chatJid = parseChatJid(data);
  if (chatJid) {
    try {
      await ctx.sendMessage(chatJid, `engineer:\n\n${summary}`);
    } catch (msgErr) {
      logger.warn({ chatJid, err: msgErr }, 'Failed to send brain mode confirmation');
    }
  }
} catch (err) {
  await handleCommandError(err, parseChatJid(data), ctx, 'set_brain_mode', {
    bot: data.bot,
    mode: data.mode,
    model: data.model,
  });
}
```

---

### Part 2: Observability

#### Trace ID Generation

**Design:** Short, readable hex string (6 characters, e.g., `a3f2c1`). Sufficient collision resistance for single-node, low-volume system (~16M combinations).

Add to `chat-activity.ts` after line 50:

```typescript
/**
 * Generate a short trace ID for correlating log events.
 * Format: 6-char lowercase hex (e.g., 'a3f2c1')
 */
export function generateTraceId(): string {
  return crypto.randomBytes(3).toString('hex');
}
```

**Usage:** Generate trace ID when container run starts, propagate through all logging calls.

#### Structured Event Schema

All lifecycle events should log with this common structure:

```typescript
interface LifecycleEvent {
  event: string;           // Event type: 'message_received' | 'container_started' | 'container_finished' | 'ipc_command'
  traceId: string;         // Trace ID for correlation
  chatJid: string;         // Which room
  timestamp: number;       // Unix timestamp (ms)
  elapsedMs?: number;      // Latency (for terminal events)
  bot?: string;            // For IPC commands
  command?: string;        // For IPC commands
  success?: boolean;       // For terminal events (container_finished, ipc_command)
  error?: string;          // Error message if success=false
  [key: string]: unknown;  // Additional context
}
```

#### Key Lifecycle Points

1. **Message Received** — When user message triggers container run
   - Where: Container run dispatch logic (likely in main router, outside scope of this spec's file changes)
   - Log: `{ event: 'message_received', traceId, chatJid, sender, contentPreview }`

2. **Container Started** — When container begins execution
   - Where: `markRunStarted()` in `chat-activity.ts` line 122
   - Log: `{ event: 'container_started', traceId, chatJid, timestamp }`

3. **IPC Command Processed** — When container sends IPC command
   - Where: Each IPC handler in `ipc-commands.ts`
   - Log: `{ event: 'ipc_command', traceId, chatJid, command, bot, success }`

4. **Container Finished** — When container exits (success or error)
   - Where: `markRunEnded()` in `chat-activity.ts` line 128
   - Log: `{ event: 'container_finished', traceId, chatJid, elapsedMs, success }`

#### Update `ChatActivity` Interface

Modify `/Users/ww5/2026-Nanoclaw/InfiniClaw/src/chat-activity.ts` line 10:

```typescript
export interface ChatActivity {
  runStartedAt?: number;
  currentTraceId?: string;  // NEW: trace ID for current run
  currentObjective?: string;
  currentObjectiveAt?: number;
  recentUserContext?: string[];
  lastProgress?: string;
  lastProgressAt?: number;
  lastCompletion?: string;
  lastCompletionAt?: number;
  lastError?: string;
  lastErrorAt?: number;
}
```

#### Update `markRunStarted`

Modify `/Users/ww5/2026-Nanoclaw/InfiniClaw/src/chat-activity.ts` line 122:

```typescript
export function markRunStarted(chatJid: string): string {
  const activity = ensureChatActivity(chatJid);
  const traceId = generateTraceId();
  activity.runStartedAt = Date.now();
  activity.currentTraceId = traceId;
  persistChatActivity(chatJid);

  logger.info(
    {
      event: 'container_started',
      traceId,
      chatJid,
      timestamp: activity.runStartedAt,
    },
    'Container run started',
  );

  return traceId; // Return trace ID for caller to propagate
}
```

#### Update `markRunEnded`

Modify `/Users/ww5/2026-Nanoclaw/InfiniClaw/src/chat-activity.ts` line 128:

```typescript
export function markRunEnded(chatJid: string, success: boolean = true, error?: string): void {
  const activity = ensureChatActivity(chatJid);
  const startedAt = activity.runStartedAt;
  const traceId = activity.currentTraceId;
  const elapsedMs = startedAt ? Date.now() - startedAt : undefined;

  activity.runStartedAt = undefined;
  activity.currentTraceId = undefined;
  persistChatActivity(chatJid);

  logger.info(
    {
      event: 'container_finished',
      traceId: traceId || 'unknown',
      chatJid,
      elapsedMs,
      success,
      error: error || undefined,
      timestamp: Date.now(),
    },
    `Container run finished (${success ? 'success' : 'error'})`,
  );

  writeMetricsEvent({
    event: 'container_finished',
    traceId: traceId || 'unknown',
    chatJid,
    elapsedMs,
    success,
    error,
    timestamp: Date.now(),
  });
}
```

#### Metrics File Writer

Add to `chat-activity.ts` after line 60:

```typescript
import fs from 'fs';
import path from 'path';

const METRICS_FILE = path.join(
  process.env.INFINICLAW_ROOT || process.cwd(),
  '_runtime',
  'data',
  'metrics.jsonl',
);

/**
 * Append a metrics event to the metrics file (NDJSON format).
 * Non-blocking, fire-and-forget. Failures are logged but don't throw.
 */
function writeMetricsEvent(event: Record<string, unknown>): void {
  try {
    const dir = path.dirname(METRICS_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(METRICS_FILE, JSON.stringify(event) + '\n', 'utf-8');
  } catch (err) {
    logger.warn({ err, event }, 'Failed to write metrics event');
  }
}
```

#### IPC Command Logging

For all IPC command handlers, add structured logging on success and error paths.

**Example** — `handleRestartBot` success case (after line 373):

```typescript
logger.info(
  {
    event: 'ipc_command',
    traceId: activity.currentTraceId,  // Get from chat activity if available
    chatJid,
    command: 'restart_bot',
    bot,
    success: true,
  },
  'IPC command: restart_bot succeeded',
);
```

**Example** — `handleCommandError` (already includes structured logging, ensure `event` field):

```typescript
logger.error(
  {
    event: 'ipc_command',
    command: commandLabel,
    chatJid: chatJid || undefined,
    success: false,
    err,
    ...context,
  },
  `IPC command failed: ${commandLabel}`,
);
```

#### Helper: Get Current Trace ID

Add to `chat-activity.ts`:

```typescript
/**
 * Get the current trace ID for a chat, if a run is active.
 * Returns undefined if no run in progress.
 */
export function getCurrentTraceId(chatJid: string): string | undefined {
  const activity = getChatActivity(chatJid);
  return activity?.currentTraceId;
}
```

#### Import Requirements

Add to top of `chat-activity.ts`:

```typescript
import crypto from 'crypto';
import { logger } from 'nanoclaw/logger.js';
```

---

## Files to Create/Modify

### New Files

1. **`/Users/ww5/2026-Nanoclaw/InfiniClaw/_runtime/data/metrics.jsonl`**
   - Created automatically on first write
   - Format: NDJSON (newline-delimited JSON)
   - Retention: Manual (future: add log rotation if file grows large)

### Modified Files

1. **`/Users/ww5/2026-Nanoclaw/InfiniClaw/src/ipc-commands.ts`**
   - Add `handleCommandError` utility function (after line 184)
   - Refactor all command handlers to use standardized error patterns
   - Add structured `event` field to all log calls
   - Add trace ID to log context where available

2. **`/Users/ww5/2026-Nanoclaw/InfiniClaw/src/chat-activity.ts`**
   - Add `generateTraceId()` function
   - Add `getCurrentTraceId()` function
   - Add `writeMetricsEvent()` function
   - Update `ChatActivity` interface to include `currentTraceId`
   - Update `markRunStarted()` to generate trace ID and log event
   - Update `markRunEnded()` to compute latency and log event
   - Add imports: `crypto`, `fs`, `path`

3. **`/Users/ww5/2026-Nanoclaw/InfiniClaw/src/chat-activity.ts` (sanitizeActivity)**
   - Add `currentTraceId` to sanitization logic (line 30-50)

### No Changes Required

- `/Users/ww5/2026-Nanoclaw/InfiniClaw/external/nanoclaw/src/logger.ts` — Uses Pino, already supports structured logging
- `/Users/ww5/2026-Nanoclaw/InfiniClaw/external/nanoclaw/src/config.ts` — No new config needed (metrics path derived from `INFINICLAW_ROOT`)
- `/Users/ww5/2026-Nanoclaw/InfiniClaw/external/nanoclaw/src/types.ts` — No new types needed

---

## Testing Plan

### Part 1: Error Handling (Architect Testing)

#### Test 1: User Feedback on Command Failure
**Scenario:** Trigger `set_brain_mode` with invalid parameters
**Steps:**
1. Send IPC command: `{ type: 'set_brain_mode', bot: 'invalid', mode: 'anthropic', chatJid: 'test-room' }`
2. Verify error logged with structured context (bot, mode)
3. Verify user receives error message in `test-room`
4. Confirm error message includes command label and context

**Expected:**
- Log line: `{ event: 'ipc_command', command: 'set_brain_mode', success: false, bot: 'invalid', ... }`
- User message: `⛔ Command failed: set_brain_mode (bot: invalid, mode: anthropic) ...`

#### Test 2: Silent Swallow Eliminated
**Scenario:** Ensure no more empty catch blocks
**Steps:**
1. Grep codebase: `rg "catch\s*\{\s*\}" src/ipc-commands.ts`
2. Verify only Pattern B/C usages remain (message send cleanup, non-critical persistence)

**Expected:**
- Zero empty catch blocks in critical command logic
- Remaining empty catches have inline comments explaining why

#### Test 3: Message Send Failure Doesn't Mask Original Error
**Scenario:** Network issue prevents user notification
**Steps:**
1. Mock `ctx.sendMessage` to throw error
2. Trigger failing command (e.g., `stop_bot` with invalid bot)
3. Verify original error logged, warning logged for message send failure
4. Verify system doesn't crash or hang

**Expected:**
- Error log: Original command failure with full context
- Warning log: Message send failure
- No exceptions propagated to caller

### Part 2: Observability (Architect Testing)

#### Test 4: Trace ID Generation and Propagation
**Scenario:** Full container run lifecycle
**Steps:**
1. Send message to bot in holodeck
2. Verify `container_started` log includes trace ID (6-char hex)
3. Trigger IPC command from container (e.g., `restart_wksm`)
4. Verify IPC command log includes same trace ID
5. Verify `container_finished` log includes same trace ID

**Expected:**
- All log lines share same `traceId` value
- Trace ID format: `/^[a-f0-9]{6}$/`

#### Test 5: Latency Tracking
**Scenario:** Measure container run duration
**Steps:**
1. Start container run
2. Wait 5 seconds
3. End container run (success)
4. Check `container_finished` log

**Expected:**
- Log includes `elapsedMs` field
- Value approximately 5000ms (±100ms tolerance)

#### Test 6: Metrics File Format
**Scenario:** Verify NDJSON structure
**Steps:**
1. Run multiple container runs
2. Read `_runtime/data/metrics.jsonl`
3. Verify each line is valid JSON
4. Verify schema matches `LifecycleEvent` interface

**Expected:**
- File exists at expected path
- Each line parseable as JSON
- Fields: `event`, `traceId`, `chatJid`, `timestamp`, `elapsedMs` (for finished events)
- No trailing commas or invalid JSON syntax

#### Test 7: Error Case Observability
**Scenario:** Container run fails
**Steps:**
1. Trigger container run that will error (e.g., syntax error in code)
2. Verify `container_finished` log includes `success: false`
3. Verify error message captured in log
4. Verify metrics file includes error event

**Expected:**
- Log: `{ event: 'container_finished', success: false, error: '...' }`
- Metrics file: Same event appended

#### Test 8: Trace ID Correlation Query
**Scenario:** Debug a failed run using trace ID
**Steps:**
1. Trigger container run, capture trace ID from first log line
2. Grep logs for trace ID: `rg "traceId.*a3f2c1" _runtime/logs/`
3. Verify all lifecycle events retrieved

**Expected:**
- Query returns: message_received → container_started → ipc_command(s) → container_finished
- All events chronologically ordered
- No missing events in lifecycle

---

## Rollout Notes

### Deployment Strategy

1. **Phase 1: Error Handling** (Lower Risk)
   - Deploy `handleCommandError` utility
   - Refactor high-priority handlers (`handleSetBrainMode`, `handleBotStatus`)
   - Test on holodeck first
   - Monitor for unexpected error message spam

2. **Phase 2: Observability Foundation** (Low Risk)
   - Add trace ID generation to `markRunStarted`
   - Add latency tracking to `markRunEnded`
   - Deploy to holodeck, verify logs

3. **Phase 3: Metrics File** (Medium Risk)
   - Add `writeMetricsEvent` calls
   - Monitor file growth rate
   - Verify no I/O blocking issues

4. **Phase 4: IPC Command Observability** (Low Risk)
   - Add structured logging to all IPC handlers
   - Verify trace ID propagation works end-to-end

### Rollback Plan

- **Error Handling:** Revert individual handler changes if user feedback becomes noisy
- **Observability:** Remove metrics file writes if I/O issues detected (keep structured logging)
- **Trace IDs:** No rollback needed (additive change, no breaking behavior)

### Performance Considerations

- **Trace ID generation:** `crypto.randomBytes(3)` is non-blocking, negligible overhead
- **Metrics file writes:** Synchronous `appendFileSync` — acceptable for low-volume system (<100 events/min). If volume increases, switch to async queue.
- **Structured logging:** Pino already handles object logging efficiently, no additional overhead

### Monitoring After Deployment

1. **Check metrics file growth:**
   ```bash
   ls -lh _runtime/data/metrics.jsonl
   ```
   Expected: ~1KB per 100 events. Monitor daily for first week.

2. **Validate NDJSON format:**
   ```bash
   cat _runtime/data/metrics.jsonl | jq -c . > /dev/null
   ```
   Should exit with code 0 (no parse errors).

3. **Spot-check trace ID correlation:**
   ```bash
   # Get a recent trace ID
   TRACE_ID=$(tail -1 _runtime/data/metrics.jsonl | jq -r .traceId)
   # Find all events with that trace ID
   rg "$TRACE_ID" _runtime/logs/
   ```
   Should return 2+ log lines (at minimum: container_started + container_finished).

---

## Open Questions

### Q1: Should we propagate trace IDs to container environment?

**Context:** Containers could include trace ID in their own logs, enabling correlation across host and container logs.

**Options:**
- **A:** Add `TRACE_ID` env var to container launch
- **B:** Keep trace IDs host-side only

**Recommendation:** Defer to Phase 2. Start with host-side only, add container propagation if debugging reveals need.

---

### Q2: Metrics file retention policy?

**Context:** Metrics file grows unbounded. At ~1KB per 100 events, 10K events = 100KB (small but eventually needs rotation).

**Options:**
- **A:** Manual cleanup (document in ops guide)
- **B:** Automatic rotation at 10MB (add to startup logic)
- **C:** Automatic rotation at 7 days (add to scheduler)

**Recommendation:** Start with **A** (manual), add **B** if file exceeds 50MB in first month of production use.

---

### Q3: Should we add trace IDs to user-facing messages?

**Context:** Advanced users could quote trace ID when reporting issues.

**Example:** `✅ Holodeck created for engineer (trace: a3f2c1)`

**Options:**
- **A:** Add trace ID to all success/error messages
- **B:** Add only to error messages
- **C:** Don't expose to users

**Recommendation:** **C** for now. Trace IDs are implementation detail. If users frequently report issues, revisit in follow-up spec.

---

### Q4: Should IPC commands receive trace ID in command payload?

**Context:** Containers could include trace ID in IPC commands they send, ensuring perfect correlation even if multiple containers run concurrently in same room.

**Options:**
- **A:** Add `traceId` field to IPC command schema (`CommandData` interface)
- **B:** Look up trace ID from chat activity on IPC receive

**Recommendation:** **B** for now. Single-bot-per-room assumption holds; if we support concurrent runs, add **A**.

---

## Summary of Changes

### TypeScript Function Signatures

```typescript
// ipc-commands.ts
async function handleCommandError(
  err: unknown,
  chatJid: string | null,
  ctx: InfiniClawIpcContext,
  commandLabel: string,
  context?: Record<string, unknown>,
): Promise<void>;

// chat-activity.ts
export function generateTraceId(): string;
export function getCurrentTraceId(chatJid: string): string | undefined;
export function markRunStarted(chatJid: string): string;  // Now returns trace ID
export function markRunEnded(chatJid: string, success?: boolean, error?: string): void;  // New params
function writeMetricsEvent(event: Record<string, unknown>): void;

// Interface changes
export interface ChatActivity {
  runStartedAt?: number;
  currentTraceId?: string;  // NEW
  currentObjective?: string;
  // ... existing fields unchanged
}
```

### Metrics File Schema

```typescript
interface MetricsEvent {
  event: 'container_started' | 'container_finished' | 'ipc_command' | 'message_received';
  traceId: string;
  chatJid: string;
  timestamp: number;  // Unix timestamp (ms)
  elapsedMs?: number;  // For container_finished events
  success?: boolean;   // For terminal events
  error?: string;      // Error message if success=false
  command?: string;    // For ipc_command events
  bot?: string;        // For ipc_command events
  [key: string]: unknown;  // Additional context
}
```

### Structured Log Fields

All lifecycle logs should include:
- `event` — Event type string
- `traceId` — Correlation ID
- `chatJid` — Room identifier
- `timestamp` or use Pino's automatic timestamp
- Additional context fields as needed (bot, command, etc.)

---

## Acceptance Criteria

This spec is considered successfully implemented when:

1. **Error Handling:**
   - [ ] `handleCommandError` utility function exists and is documented
   - [ ] All IPC command handlers use one of three documented error patterns
   - [ ] Zero empty catch blocks in critical command logic paths
   - [ ] All command errors log with structured context (command, chatJid, additional fields)
   - [ ] All command errors (when chatJid present) send user-visible feedback

2. **Observability:**
   - [ ] `markRunStarted` generates 6-char hex trace ID and logs `container_started` event
   - [ ] `markRunEnded` computes elapsed time and logs `container_finished` event with latency
   - [ ] Metrics file (`_runtime/data/metrics.jsonl`) receives all terminal events
   - [ ] All IPC command handlers log with `event: 'ipc_command'` and trace ID
   - [ ] Architect can grep logs by trace ID and retrieve full lifecycle

3. **Testing:**
   - [ ] All 8 test scenarios in Testing Plan pass on holodeck
   - [ ] No performance degradation (container startup time <1% increase)
   - [ ] Metrics file format validates as NDJSON

4. **Documentation:**
   - [ ] Error handling patterns documented inline (comments in `handleCommandError`)
   - [ ] Metrics file format documented in this spec
   - [ ] Rollout notes reviewed and approved by Captain

---

**End of Spec**
