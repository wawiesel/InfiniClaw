# 26 — Zero-Downtime Relay Restart

> **Status:** Proposed. Not yet implemented.

## Problem

Relay restarts cause downtime in three areas:

1. **Warmup gap** (~30s) — Matrix sync catchup, no commands processed
2. **Bootstrap gap** (~2-3 min) — building/starting bots (preserved bots keep running via PM2)
3. **Intercom gap** — relay not watching rooms during startup; commands and messages missed
4. **Relay-tasks gap** — branch brain dispatches, git pushes pile up unprocessed

Bots survive relay restarts (PM2 keeps them alive), but they lose intercom routing, command processing, and relay-task handling until the new relay is fully online.

## Solution: Two Layers

### Layer 1: S3-Coordinated Blue-Green (for any relay restart)

Start a new relay alongside the old one. Use an S3 lock to coordinate the handoff so only one relay processes messages at a time.

**Flow:**

1. Start new relay process (different PM2 name, e.g. `infiniclaw-relay-next`)
2. New relay connects to Matrix, does initial sync (30s warmup)
3. New relay writes `relay-handoff/{ship}.json` to S3:
   ```json
   {
     "newRelayId": "relay-next-1710936000",
     "status": "warming",
     "timestamp": 1710936000
   }
   ```
4. New relay finishes warmup, updates status to `"ready"`
5. Old relay sees `"ready"` on its next S3 poll (health loop, ~30s), updates status to `"draining"`
6. Old relay stops consuming new intercom messages and relay-tasks, finishes in-flight work
7. Old relay updates status to `"drained"`, exits
8. New relay sees `"drained"` (or timeout), acquires the lock, begins normal operation
9. New relay clears the handoff key

**Conflict prevention:** During the brief overlap window (steps 5-7), the S3 handoff key acts as a mutex. Only the relay holding the `"active"` status processes new messages. The old relay's drain is bounded by a timeout (e.g. 60s) — if it doesn't finish, the new relay takes over anyway.

**Fallback:** If the new relay crashes during warmup, the old relay continues uninterrupted. The handoff key has a TTL — if no `"ready"` appears within 5 minutes, the old relay cleans up the stale key.

### Layer 2: Router/Worker Split (for code deploys)

Split the relay into two processes: a persistent router and a restartable worker. The router never restarts for code changes — only for infrastructure changes (Node upgrade, Matrix credential rotation).

**Router (persistent, thin):**
- Connects to Matrix, watches all intercom rooms
- Forwards raw events to the Worker via IPC (Unix domain socket)
- Buffers messages during worker restart (bounded buffer, e.g. 1000 messages)
- Handles the S3 heartbeat
- Restarts only for infra changes (uses Layer 1 blue-green when it does)

**Worker (restartable, all business logic):**
- Receives events from Router via IPC
- All current relay logic: command dispatch, bot lifecycle, fleet management, branch brain spawning, git sync, relay-tasks, duty cycle, metrics
- Signals "ready" to Router on startup; Router flushes buffered messages
- PM2 manages restarts; Router detects worker exit and buffers until new worker connects

**IPC protocol (Unix domain socket):**

```
Router → Worker:
  { type: "matrix_event", event: <raw Matrix event> }
  { type: "relay_task", task: <relay-task file content> }

Worker → Router:
  { type: "ready" }
  { type: "send_message", room: "<room_id>", body: "<text>", ... }
```

The Router's only outbound Matrix action is sending messages on behalf of the Worker.

**Restart flow:**
1. New code deployed (git pull, npm build)
2. `pm2 restart infiniclaw-worker`
3. Router detects worker disconnect, starts buffering
4. New worker starts, connects to Router socket, sends `{ type: "ready" }`
5. Router flushes buffered messages to worker
6. Zero gap — no Matrix reconnection needed, no warmup, no missed messages

## Migration Path

1. **Phase 1:** Implement Layer 1 (blue-green) as a standalone feature. This works with the current monolithic relay and provides zero-downtime for any restart.
2. **Phase 2:** Implement Layer 2 (router/worker split). This makes code deploys instant and reduces the need for Layer 1 to rare infra changes only.

Phase 1 alone covers the immediate need. Phase 2 is the long-term architecture.

## Implementation Scope

### Phase 1 (blue-green)

| Area | Change |
|------|--------|
| Relay startup | Check for existing handoff key; if found, wait or abort |
| Relay main loop | Poll handoff key in health loop; initiate drain on `"ready"` |
| Relay shutdown | Write `"drained"` to handoff key before exit |
| New CLI command | `!relay restart` — starts blue-green handoff (operator or Captain) |
| S3 | New key pattern: `relay-handoff/{ship}.json` |

### Phase 2 (router/worker)

| Area | Change |
|------|--------|
| New process | `relay-router.ts` — thin Matrix connector + IPC server + message buffer |
| Refactor | Extract all business logic from relay.ts into `relay-worker.ts` |
| IPC | Unix domain socket at `_runtime/relay-worker.sock` |
| PM2 config | Two processes: `infiniclaw-router` (persistent) + `infiniclaw-worker` (restartable) |
| Router | Matrix connection, event forwarding, send-on-behalf, heartbeat |
| Worker | All current relay logic, connects to router socket on startup |

## Safety

- Layer 1: Old relay continues if new relay fails to start. Handoff key has TTL.
- Layer 2: Router buffers during worker restart. Bounded buffer prevents memory exhaustion. If buffer fills, oldest messages dropped with warning.
- Both layers: Bots remain alive via PM2 throughout. Only intercom routing is affected.
- Rollback: Kill new relay / worker, old one resumes (Layer 1) or Router continues with restarted old worker (Layer 2).
