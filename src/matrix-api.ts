/**
 * Low-level Matrix API helpers.
 * Single source of truth for fetch-based Matrix operations used by relay, intercom, and service modules.
 */
import fs from 'fs';
import path from 'path';

import { marked } from 'marked';
import { loadShipConfig } from './ship-config.js';

// ── Constants ───────────────────────────────────────────────────────

const MATRIX_API = '/_matrix/client/v3';
const MATRIX_OP_TIMEOUT_MS = 15_000;

// ── Types ───────────────────────────────────────────────────────────

export interface IntercomRoom {
  roomId: string;
  username: string;
  password: string;
}

export interface IntercomConfig {
  homeserver: string;
  rooms: Record<string, IntercomRoom>;
}

export interface MatrixCredentials {
  homeserver: string;
  accessToken: string;
}

export interface SyncResponse {
  next_batch: string;
  rooms?: {
    join?: Record<string, {
      timeline?: {
        events?: Array<{
          type: string;
          sender: string;
          content?: { msgtype?: string; body?: string };
          event_id: string;
          origin_server_ts: number;
        }>;
      };
    }>;
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function matrixHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

function txnId(prefix = 'mx'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Convert markdown to Matrix formatted_body HTML. */
export function markdownToHtml(text: string): string {
  const html = (marked.parse(text, { async: false, breaks: true }) as string).trim();
  return html.replace(/^ +/gm, (m) => '&nbsp;'.repeat(m.length));
}

// ── Auth ─────────────────────────────────────────────────────────────

export async function matrixLogin(
  homeserver: string,
  username: string,
  password: string,
  deviceId?: string,
): Promise<{ accessToken: string; userId: string }> {
  const resp = await fetch(`${homeserver}${MATRIX_API}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'm.login.password',
      user: username,
      password,
      ...(deviceId && { device_id: deviceId }),
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Login failed for ${username}: ${resp.status} ${body}`);
  }
  const data = await resp.json() as { access_token: string; user_id: string };
  return { accessToken: data.access_token, userId: data.user_id };
}

export async function matrixLogout(homeserver: string, token: string): Promise<void> {
  await fetch(`${homeserver}${MATRIX_API}/logout`, {
    method: 'POST',
    headers: matrixHeaders(token),
    body: '{}',
  }).catch(() => {});
}

// ── Sync ─────────────────────────────────────────────────────────────

export async function matrixCreateFilter(
  homeserver: string,
  token: string,
  userId: string,
): Promise<string> {
  const filter = {
    room: {
      timeline: { limit: 10, types: ['m.room.message'] },
      state: { types: [] },
      ephemeral: { types: [] },
      account_data: { types: [] },
    },
    presence: { types: [] },
    account_data: { types: [] },
  };
  const resp = await fetch(
    `${homeserver}${MATRIX_API}/user/${encodeURIComponent(userId)}/filter`,
    { method: 'POST', headers: matrixHeaders(token), body: JSON.stringify(filter) },
  );
  if (!resp.ok) throw new Error(`Filter creation failed: ${resp.status}`);
  const data = await resp.json() as { filter_id: string };
  return data.filter_id;
}

export async function matrixSync(
  homeserver: string,
  token: string,
  since: string | null,
  filterId: string | null,
  timeout: number,
): Promise<SyncResponse> {
  const params = new URLSearchParams({ timeout: String(timeout) });
  if (since) params.set('since', since);
  if (filterId) params.set('filter', filterId);
  const resp = await fetch(`${homeserver}${MATRIX_API}/sync?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeout + 15_000),
  });
  if (!resp.ok) throw new Error(`Sync failed: ${resp.status}`);
  return resp.json() as Promise<SyncResponse>;
}

// ── Message sending ──────────────────────────────────────────────────

export interface SendOpts {
  homeserver: string;
  token: string;
  roomId: string;
  text: string;
  /** If set, sends as a thread reply to this event. */
  threadRootId?: string;
  /** If true, send plain text without markdown formatting. */
  plain?: boolean;
  /** Log function for errors. */
  log?: (msg: string) => void;
}

/**
 * Send a message to a Matrix room. Supports plain, formatted, and threaded messages.
 * Returns the event_id on success, undefined on failure.
 */
export async function matrixSend(opts: SendOpts): Promise<string | undefined> {
  const { homeserver, token, roomId, text, threadRootId, plain, log: logFn } = opts;
  const id = txnId('sv');
  const content: Record<string, unknown> = { msgtype: 'm.text', body: text };

  if (!plain) {
    content.format = 'org.matrix.custom.html';
    content.formatted_body = markdownToHtml(text);
  }

  if (threadRootId) {
    content['m.relates_to'] = { rel_type: 'm.thread', event_id: threadRootId };
  }

  const resp = await fetch(
    `${homeserver}${MATRIX_API}/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(id)}`,
    { method: 'PUT', headers: matrixHeaders(token), body: JSON.stringify(content) },
  );
  if (!resp.ok) {
    const body = await resp.text();
    if (logFn) logFn(`send failed to ${roomId}: ${resp.status} ${body}`);
    return undefined;
  }
  const data = await resp.json() as { event_id?: string };
  return data.event_id;
}

// ── Room membership ──────────────────────────────────────────────────

export async function matrixInvite(
  homeserver: string,
  token: string,
  roomId: string,
  userId: string,
): Promise<boolean> {
  const resp = await fetch(
    `${homeserver}${MATRIX_API}/rooms/${encodeURIComponent(roomId)}/invite`,
    {
      method: 'POST',
      headers: matrixHeaders(token),
      body: JSON.stringify({ user_id: userId }),
      signal: AbortSignal.timeout(MATRIX_OP_TIMEOUT_MS),
    },
  );
  if (!resp.ok) {
    const body = await resp.text();
    if (body.includes('already in the room') || body.includes('already joined')) return true;
    return false;
  }
  return true;
}

export async function matrixJoin(
  homeserver: string,
  token: string,
  roomId: string,
): Promise<boolean> {
  const resp = await fetch(
    `${homeserver}${MATRIX_API}/rooms/${encodeURIComponent(roomId)}/join`,
    {
      method: 'POST',
      headers: matrixHeaders(token),
      body: '{}',
      signal: AbortSignal.timeout(MATRIX_OP_TIMEOUT_MS),
    },
  );
  if (!resp.ok) {
    const body = await resp.text();
    if (body.includes('already in the room') || body.includes('already joined')) return true;
    return false;
  }
  return true;
}

export async function matrixLeave(
  homeserver: string,
  token: string,
  roomId: string,
): Promise<boolean> {
  const resp = await fetch(
    `${homeserver}${MATRIX_API}/rooms/${encodeURIComponent(roomId)}/leave`,
    {
      method: 'POST',
      headers: matrixHeaders(token),
      body: '{}',
      signal: AbortSignal.timeout(MATRIX_OP_TIMEOUT_MS),
    },
  );
  if (!resp.ok) {
    const body = await resp.text();
    if (resp.status === 403 || body.includes('not in room') || body.includes('not a member')) return true;
    return false;
  }
  return true;
}

export async function matrixSetDisplayName(
  homeserver: string,
  token: string,
  userId: string,
  displayName: string,
): Promise<boolean> {
  const resp = await fetch(
    `${homeserver}${MATRIX_API}/profile/${encodeURIComponent(userId)}/displayname`,
    {
      method: 'PUT',
      headers: matrixHeaders(token),
      body: JSON.stringify({ displayname: displayName }),
      signal: AbortSignal.timeout(MATRIX_OP_TIMEOUT_MS),
    },
  );
  return resp.ok;
}

export async function matrixSetRoomName(
  homeserver: string,
  token: string,
  roomId: string,
  name: string,
): Promise<boolean> {
  const resp = await fetch(
    `${homeserver}${MATRIX_API}/rooms/${encodeURIComponent(roomId)}/state/m.room.name/`,
    {
      method: 'PUT',
      headers: matrixHeaders(token),
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(MATRIX_OP_TIMEOUT_MS),
    },
  );
  return resp.ok;
}

// ── Room history ─────────────────────────────────────────────────────

export interface MatrixEvent {
  type: string;
  sender: string;
  event_id: string;
  origin_server_ts: number;
  content?: Record<string, unknown>;
}

/**
 * Fetch messages from a Matrix room using the /messages endpoint.
 * Returns events in reverse-chronological order (newest first) by default.
 * Use `from` token from previous response for pagination.
 */
export async function matrixGetMessages(
  homeserver: string,
  token: string,
  roomId: string,
  opts?: { limit?: number; from?: string; dir?: 'b' | 'f'; filter?: string },
): Promise<{ chunk: MatrixEvent[]; end?: string }> {
  const params = new URLSearchParams({
    dir: opts?.dir ?? 'b',
    limit: String(opts?.limit ?? 100),
  });
  if (opts?.from) params.set('from', opts.from);
  if (opts?.filter) params.set('filter', opts.filter);
  const resp = await fetch(
    `${homeserver}${MATRIX_API}/rooms/${encodeURIComponent(roomId)}/messages?${params}`,
    { headers: matrixHeaders(token), signal: AbortSignal.timeout(MATRIX_OP_TIMEOUT_MS) },
  );
  if (!resp.ok) throw new Error(`/messages failed for ${roomId}: ${resp.status}`);
  const data = await resp.json() as { chunk: MatrixEvent[]; end?: string };
  return data;
}

/**
 * Fetch relations (reactions, threads, etc.) for a specific event.
 * Used to find scoring reactions on bot messages.
 */
export async function matrixGetRelations(
  homeserver: string,
  token: string,
  roomId: string,
  eventId: string,
  relType?: string,
): Promise<MatrixEvent[]> {
  const relPath = relType ? `/m.annotation` : '';
  const resp = await fetch(
    `${homeserver}${MATRIX_API}/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(eventId)}${relPath}`,
    { headers: matrixHeaders(token), signal: AbortSignal.timeout(MATRIX_OP_TIMEOUT_MS) },
  );
  if (!resp.ok) return [];
  const data = await resp.json() as { chunk: MatrixEvent[] };
  return data.chunk ?? [];
}

// ── Intercom config ──────────────────────────────────────────────────

let cachedIntercomConfig: IntercomConfig | null = null;

export function loadIntercomConfig(): IntercomConfig | null {
  if (cachedIntercomConfig) return cachedIntercomConfig;
  try {
    const secretsPath = loadShipConfig().secretsPath;
    const configPath = path.join(secretsPath, 'operator', 'intercom.json');
    if (!fs.existsSync(configPath)) return null;
    cachedIntercomConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return cachedIntercomConfig;
  } catch {
    return null;
  }
}

/** Clear cached intercom config (e.g. after secrets repo sync). */
export function clearIntercomConfigCache(): void {
  cachedIntercomConfig = null;
}
