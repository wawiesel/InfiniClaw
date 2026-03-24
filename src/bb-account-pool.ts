/**
 * BB Account Pool — Design 28
 *
 * Each BB container has a pool of up to 3 permanent Matrix accounts.
 * Credentials are supplied via env vars:
 *   BB_POOL_USER_1=@bb1-tali:matrix.server   BB_POOL_TOKEN_1=syt_...
 *   BB_POOL_USER_2=@bb2-tali:matrix.server   BB_POOL_TOKEN_2=syt_...
 *   BB_POOL_USER_3=@bb3-tali:matrix.server   BB_POOL_TOKEN_3=syt_...
 *
 * On activation a free slot is claimed, its display name is set to
 * `{6-digit-index}-{botname}`, and the token is returned to the caller.
 * The slot must be released (releaseBbPoolSlot) when work is done.
 *
 * Old "shared" behaviour is the default; this module is only invoked when
 * BB_ACCOUNT_MODE=pool.
 */
import crypto from 'crypto';

import { logger } from 'nanoclaw/logger.js';

// ── Pool size hard-clamp ─────────────────────────────────────────────

/** Hard maximum number of pool slots.  Any vars beyond this index are an error. */
export const MAX_POOL_SIZE = 3;

// ── Pool state ───────────────────────────────────────────────────────

interface PoolEntry {
  userId: string;
  /** Pre-obtained Matrix access token. */
  accessToken: string;
}

/** Indexed 0..MAX_POOL_SIZE-1.  null = slot not configured. */
let _pool: (PoolEntry | null)[] = [];
/** true = slot is currently in use. */
let _slotActive: boolean[] = [];
let _initialised = false;

/**
 * Initialise the pool from env vars.
 *
 * Hard-clamp: throws if BB_POOL_USER_N or BB_POOL_TOKEN_N is set for any
 * N > MAX_POOL_SIZE, since that indicates a misconfiguration.
 *
 * Called automatically on first acquire if not called explicitly.
 */
export function initBbPool(env: NodeJS.ProcessEnv = process.env): void {
  // Hard-clamp check: no extra slots permitted beyond MAX_POOL_SIZE.
  for (let extra = MAX_POOL_SIZE + 1; extra <= MAX_POOL_SIZE + 10; extra++) {
    if (env[`BB_POOL_USER_${extra}`] || env[`BB_POOL_TOKEN_${extra}`]) {
      throw new Error(
        `BB pool misconfiguration: BB_POOL_USER_${extra}/BB_POOL_TOKEN_${extra} is set but pool is hard-clamped to ${MAX_POOL_SIZE} slots`,
      );
    }
  }

  _pool = [];
  _slotActive = [];

  for (let i = 0; i < MAX_POOL_SIZE; i++) {
    const n = i + 1;
    const userId = env[`BB_POOL_USER_${n}`] ?? '';
    const accessToken = env[`BB_POOL_TOKEN_${n}`] ?? '';
    if (userId && accessToken) {
      _pool.push({ userId, accessToken });
      logger.debug({ slot: n, userId }, 'BB pool: slot configured');
    } else {
      _pool.push(null);
    }
    _slotActive.push(false);
  }

  _initialised = true;
  const configured = _pool.filter(Boolean).length;
  logger.info({ configured, max: MAX_POOL_SIZE }, 'BB pool: initialised');
}

// ── Slot claim / release ─────────────────────────────────────────────

/** Claim the first idle configured slot.  Returns 0-based index or -1. */
function _claimSlot(): number {
  for (let i = 0; i < MAX_POOL_SIZE; i++) {
    if (_pool[i] && !_slotActive[i]) {
      _slotActive[i] = true;
      return i;
    }
  }
  return -1;
}

/** Release a previously claimed slot. */
export function releaseBbPoolSlot(slot: number): void {
  if (slot >= 0 && slot < MAX_POOL_SIZE) _slotActive[slot] = false;
}

// ── Matrix CS API helpers ────────────────────────────────────────────

async function matrixFetch(
  homeserver: string,
  method: string,
  path_: string,
  body?: unknown,
  accessToken?: string,
): Promise<unknown> {
  const url = `${homeserver.replace(/\/$/, '')}${path_}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Matrix ${method} ${path_} → ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res.json();
}

async function setBbDisplayName(
  homeserver: string,
  userId: string,
  accessToken: string,
  displayName: string,
): Promise<void> {
  const encoded = encodeURIComponent(userId);
  await matrixFetch(
    homeserver,
    'PUT',
    `/_matrix/client/v3/profile/${encoded}/displayname`,
    { displayname: displayName },
    accessToken,
  );
}

async function joinBbRoom(homeserver: string, roomId: string, accessToken: string): Promise<void> {
  const encoded = encodeURIComponent(roomId);
  await matrixFetch(homeserver, 'POST', `/_matrix/client/v3/join/${encoded}`, {}, accessToken);
}

// ── Public API ───────────────────────────────────────────────────────

/** Persistent state for an acquired pool slot, returned to the caller. */
export interface BbPoolSlot {
  /** 0-based index (0 = slot 1, 1 = slot 2, 2 = slot 3). */
  slot: number;
  /** Zero-padded 6-digit activation index, e.g. "384729". */
  index: string;
  userId: string;
  accessToken: string;
  homeserver: string;
}

/** Generate a zero-padded random 6-digit decimal string, e.g. "007412". */
function randomIndex(): string {
  const n = Math.floor(Math.random() * 1_000_000);
  return String(n).padStart(6, '0');
}

/**
 * Acquire an idle BB pool slot for the given bot.
 *
 * - Reads credentials from BB_POOL_USER_N / BB_POOL_TOKEN_N env vars
 *   (pool is auto-initialised from process.env on first call)
 * - Sets the pool account's display name to `{index}-{bot}`
 * - Ensures the account is joined to the target room
 *
 * Returns null if all slots are busy, none are configured, or the
 * display-name call fails.  Caller MUST call releaseBbPoolSlot(slot.slot)
 * in a finally block.
 */
export async function acquireBbPoolSlot(
  bot: string,
  homeserver: string,
  roomId: string,
): Promise<BbPoolSlot | null> {
  if (!_initialised) initBbPool();

  const slotIdx = _claimSlot();
  if (slotIdx === -1) {
    logger.warn({ bot }, 'BB pool: all slots busy or unconfigured');
    return null;
  }

  const entry = _pool[slotIdx]!;

  try {
    const index = randomIndex();
    const displayName = `${index}-${bot}`;

    await setBbDisplayName(homeserver, entry.userId, entry.accessToken, displayName);
    logger.info({ bot, slot: slotIdx + 1, userId: entry.userId, displayName }, 'BB pool slot acquired');

    // Ensure the account is in the room before posting
    try {
      await joinBbRoom(homeserver, roomId, entry.accessToken);
    } catch (err) {
      // 403 / already-joined is not fatal
      logger.debug({ err, roomId }, 'BB pool: joinRoom skipped or failed (may already be joined)');
    }

    return { slot: slotIdx, index, userId: entry.userId, accessToken: entry.accessToken, homeserver };
  } catch (err) {
    releaseBbPoolSlot(slotIdx);
    logger.warn({ err, bot, slotIdx }, 'BB pool: slot acquisition failed');
    return null;
  }
}

/** Reset the pool account display name back to a neutral placeholder. */
export async function resetBbDisplayName(slot: BbPoolSlot, bot: string): Promise<void> {
  try {
    await setBbDisplayName(slot.homeserver, slot.userId, slot.accessToken, `bb${slot.slot + 1}-${bot}`);
  } catch (err) {
    logger.warn({ err, userId: slot.userId }, 'BB pool: failed to reset display name');
  }
}

/** Send a plain-text message as the BB pool account, optionally inside a thread. */
export async function sendBbMessage(
  slot: BbPoolSlot,
  roomId: string,
  text: string,
  threadId?: string,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const content: Record<string, any> = {
    msgtype: 'm.text',
    body: text,
  };
  if (threadId) {
    content['m.relates_to'] = {
      rel_type: 'm.thread',
      event_id: threadId,
      is_falling_back: false,
    };
  }
  const txnId = crypto.randomUUID().replace(/-/g, '');
  const encoded = encodeURIComponent(roomId);
  await matrixFetch(
    slot.homeserver,
    'PUT',
    `/_matrix/client/v3/rooms/${encoded}/send/m.room.message/${txnId}`,
    content,
    slot.accessToken,
  );
}
