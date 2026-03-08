import { marked } from 'marked';
import { logger } from 'nanoclaw/logger.js';

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

export async function matrixLogin(homeserver: string, username: string, password: string, deviceId: string): Promise<{ accessToken: string; userId: string }> {
  const resp = await fetch(`${homeserver}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'm.login.password',
      user: username,
      password,
      device_id: deviceId,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Login failed for ${username}: ${resp.status} ${body}`);
  }
  const data = await resp.json() as { access_token: string; user_id: string };
  return { accessToken: data.access_token, userId: data.user_id };
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
  const resp = await fetch(`${homeserver}/_matrix/client/v3/sync?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeout + 15_000),
  });
  if (!resp.ok) throw new Error(`Sync failed: ${resp.status}`);
  return resp.json() as Promise<SyncResponse>;
}

export function markdownToHtml(text: string): string {
  const html = (marked.parse(text, { async: false, breaks: true }) as string).trim();
  return html.replace(/^ +/gm, (m) => '&nbsp;'.repeat(m.length));
}

export async function matrixSend(homeserver: string, token: string, roomId: string, text: string, threadRootId?: string): Promise<string | undefined> {
  const txnId = `sv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const content: Record<string, unknown> = {
    msgtype: 'm.text',
    body: text,
    format: 'org.matrix.custom.html',
    formatted_body: markdownToHtml(text),
  };
  if (threadRootId) {
    content['m.relates_to'] = { rel_type: 'm.thread', event_id: threadRootId };
  }
  const resp = await fetch(
    `${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(content),
    },
  );
  if (!resp.ok) {
    const body = await resp.text();
    logger.error({ roomId, status: resp.status, body }, 'Matrix send failed');
    return undefined;
  }
  const data = await resp.json() as { event_id?: string };
  return data.event_id;
}

export async function botJoinRoom(botToken: string, homeserver: string, roomId: string, intercomToken: string | null, botUserId: string): Promise<void> {
  if (intercomToken) {
    await fetch(`${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${intercomToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: botUserId }),
    });
  }
  const resp = await fetch(`${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!resp.ok) throw new Error(`Join room failed: ${resp.status}`);
}

export async function botLeaveRoom(token: string, homeserver: string, roomId: string): Promise<void> {
  const resp = await fetch(`${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!resp.ok && resp.status !== 403) throw new Error(`Leave room failed: ${resp.status}`);
}
