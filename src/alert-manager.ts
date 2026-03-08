import { RoomConn } from './command-registry.js';
import { formatTimestamp, formatDuration } from './utils.js';

interface FailureState {
  startedAt: number;
  threadRootId: string;
  nextAlertAt: number;
  intervalMs: number;
}

const FAILURE_INITIAL_INTERVAL = 60_000;
const FAILURE_MAX_INTERVAL = 8 * 60 * 60_000;
const failureStates: Record<string, FailureState> = {};

export function statusLine(emoji: string, what: string, status: string, elapsedMs: number, hostname: string): string {
  const time = elapsedMs > 0
    ? `${formatTimestamp()} · ${formatDuration(elapsedMs)}`
    : formatTimestamp();
  return `${emoji} ${what} (${hostname}) ${status} (${time})`;
}

export async function reportFailure(
  system: string, 
  detail: string, 
  conn: RoomConn, 
  hostname: string,
  replyFn: (conn: RoomConn, text: string) => Promise<string | undefined>,
  threadReplyFn: (conn: RoomConn, rootId: string, text: string) => Promise<void>
): Promise<void> {
  const now = Date.now();
  if (!conn.accessToken) return;

  const existing = failureStates[system];
  if (!existing) {
    const rootId = await replyFn(conn, statusLine('⚠️', system, 'down', 0, hostname));
    if (!rootId) return;
    await threadReplyFn(conn, rootId, detail.slice(0, 500));
    failureStates[system] = {
      startedAt: now,
      threadRootId: rootId,
      nextAlertAt: now + FAILURE_INITIAL_INTERVAL,
      intervalMs: FAILURE_INITIAL_INTERVAL,
    };
    return;
  }

  if (now < existing.nextAlertAt) return;
  await threadReplyFn(conn, existing.threadRootId, statusLine('⚠️', system, 'down', now - existing.startedAt, hostname));
  existing.intervalMs = Math.min(existing.intervalMs * 2, FAILURE_MAX_INTERVAL);
  existing.nextAlertAt = now + existing.intervalMs;
}

export async function reportRecovery(
  system: string, 
  conn: RoomConn, 
  hostname: string,
  threadReplyFn: (conn: RoomConn, rootId: string, text: string) => Promise<void>,
  replyFn: (conn: RoomConn, text: string) => Promise<string | undefined>
): Promise<void> {
  const state = failureStates[system];
  if (!state) return;
  delete failureStates[system];

  if (!conn.accessToken) return;
  const recoveryMsg = statusLine('✅', system, 'operational', Date.now() - state.startedAt, hostname);
  await threadReplyFn(conn, state.threadRootId, recoveryMsg);
  await replyFn(conn, recoveryMsg);
}
