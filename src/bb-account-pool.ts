/**
 * BB Account Pool — Design 28
 *
 * Each bot has a pool of up to 3 permanent Matrix accounts for Branch Brains.
 * Credentials are supplied via env vars (from the bot's env file):
 *   BB_POOL_USER_1=@bb1-tali:matrix.server   BB_POOL_TOKEN_1=syt_...
 *   BB_POOL_USER_2=@bb2-tali:matrix.server   BB_POOL_TOKEN_2=syt_...
 *   BB_POOL_USER_3=@bb3-tali:matrix.server   BB_POOL_TOKEN_3=syt_...
 *
 * Pools are per-bot: each bot's credentials are isolated so multiple bots
 * can use BB pools simultaneously without interference.
 *
 * On activation a free slot is claimed, its display name is set to
 * `{6-digit-index}-{botname}`, and the token is returned to the caller.
 * The slot must be released (releaseBbPoolSlot) when work is done.
 *
 * The relay reads BB_ACCOUNT_MODE from each bot's env file, not from
 * its own process.env. This allows per-bot pool configuration.
 */
import crypto from 'crypto';

import { logger } from 'nanoclaw/logger.js';
import { markdownToHtml } from './matrix-api.js';

// ── Pool size hard-clamp ─────────────────────────────────────────────

/** Hard maximum number of pool slots.  Any vars beyond this index are an error. */
export const MAX_POOL_SIZE = 3;

// ── Pool state (per-bot) ────────────────────────────────────────────

interface PoolEntry {
  userId: string;
  /** Pre-obtained Matrix access token. */
  accessToken: string;
}

interface BotPool {
  pool: (PoolEntry | null)[];
  slotActive: boolean[];
}

/** Per-bot pool state. Key = lowercase bot name. */
const _botPools: Map<string, BotPool> = new Map();

/**
 * Initialise the pool for a specific bot from its env vars.
 *
 * Hard-clamp: throws if BB_POOL_USER_N or BB_POOL_TOKEN_N is set for any
 * N > MAX_POOL_SIZE, since that indicates a misconfiguration.
 *
 * Safe to call multiple times for the same bot — re-initialises credentials
 * while preserving active slot state (so in-flight BBs aren't disrupted).
 */
export function initBbPool(bot: string, env: Record<string, string | undefined>): void {
  // Hard-clamp check: no extra slots permitted beyond MAX_POOL_SIZE.
  for (let extra = MAX_POOL_SIZE + 1; extra <= MAX_POOL_SIZE + 10; extra++) {
    if (env[`BB_POOL_USER_${extra}`] || env[`BB_POOL_TOKEN_${extra}`]) {
      throw new Error(
        `BB pool misconfiguration (${bot}): BB_POOL_USER_${extra}/BB_POOL_TOKEN_${extra} is set but pool is hard-clamped to ${MAX_POOL_SIZE} slots`,
      );
    }
  }

  const existing = _botPools.get(bot);
  const pool: (PoolEntry | null)[] = [];
  const slotActive: boolean[] = [];

  for (let i = 0; i < MAX_POOL_SIZE; i++) {
    const n = i + 1;
    const userId = env[`BB_POOL_USER_${n}`] ?? '';
    const accessToken = env[`BB_POOL_TOKEN_${n}`] ?? '';
    if (userId && accessToken) {
      pool.push({ userId, accessToken });
      logger.debug({ bot, slot: n, userId }, 'BB pool: slot configured');
    } else {
      pool.push(null);
    }
    // Preserve active state from existing pool to avoid disrupting in-flight BBs
    slotActive.push(existing?.slotActive[i] ?? false);
  }

  _botPools.set(bot, { pool, slotActive });
  const configured = pool.filter(Boolean).length;
  logger.info({ bot, configured, max: MAX_POOL_SIZE }, 'BB pool: initialised');
}

// ── Slot claim / release ─────────────────────────────────────────────

/** Claim the first idle configured slot for a bot.  Returns 0-based index or -1. */
function _claimSlot(bot: string): number {
  const bp = _botPools.get(bot);
  if (!bp) return -1;
  for (let i = 0; i < MAX_POOL_SIZE; i++) {
    if (bp.pool[i] && !bp.slotActive[i]) {
      bp.slotActive[i] = true;
      return i;
    }
  }
  return -1;
}

/** Release a previously claimed slot for a bot. */
export function releaseBbPoolSlot(bot: string, slot: number): void {
  const bp = _botPools.get(bot);
  if (bp && slot >= 0 && slot < MAX_POOL_SIZE) bp.slotActive[slot] = false;
}

/** Return the number of currently active BB slots for a bot. Returns 0 if pool is uninitialised. */
export function getActiveBbCount(bot: string): number {
  const bp = _botPools.get(bot);
  if (!bp) return 0;
  return bp.slotActive.filter(Boolean).length;
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
  /** Bot this slot belongs to. */
  bot: string;
}

/** Generate a zero-padded random 6-digit decimal string, e.g. "007412". */
function randomIndex(): string {
  const n = Math.floor(Math.random() * 1_000_000);
  return String(n).padStart(6, '0');
}

/**
 * Acquire an idle BB pool slot for the given bot.
 *
 * - Pool must be initialised via initBbPool(bot, env) before calling
 * - Sets the pool account's display name to `{index}-{bot}`
 * - Ensures the account is joined to the target room
 *
 * Returns null if all slots are busy, none are configured, or the
 * display-name call fails.  Caller MUST call releaseBbPoolSlot(bot, slot.slot)
 * in a finally block.
 */
export async function acquireBbPoolSlot(
  bot: string,
  homeserver: string,
  roomId: string,
  inviteFn?: (userId: string) => Promise<void>,
): Promise<BbPoolSlot | null> {
  const bp = _botPools.get(bot);
  if (!bp) {
    logger.warn({ bot }, 'BB pool: not initialised for bot');
    return null;
  }

  const slotIdx = _claimSlot(bot);
  if (slotIdx === -1) {
    logger.warn({ bot }, 'BB pool: all slots busy or unconfigured');
    return null;
  }

  const entry = bp.pool[slotIdx]!;

  try {
    const index = randomIndex();
    const displayName = `${index}-${bot}`;

    await setBbDisplayName(homeserver, entry.userId, entry.accessToken, displayName);
    logger.info({ bot, slot: slotIdx + 1, userId: entry.userId, displayName }, 'BB pool slot acquired');

    // Invite BB account to room (rooms may be invite-only), then join
    if (inviteFn) {
      try { await inviteFn(entry.userId); } catch (err) {
        logger.debug({ err, roomId }, 'BB pool: invite failed (may already be member)');
      }
    }
    try {
      await joinBbRoom(homeserver, roomId, entry.accessToken);
    } catch (err) {
      logger.warn({ err, roomId, userId: entry.userId }, 'BB pool: joinRoom failed');
    }

    return { slot: slotIdx, index, userId: entry.userId, accessToken: entry.accessToken, homeserver, bot };
  } catch (err) {
    releaseBbPoolSlot(bot, slotIdx);
    logger.warn({ err, bot, slotIdx }, 'BB pool: slot acquisition failed');
    return null;
  }
}

/** Leave a room as the BB pool account. Called on deactivation (merge/abort/timeout/error). */
export async function leaveBbRoom(slot: BbPoolSlot, roomId: string): Promise<void> {
  try {
    const encoded = encodeURIComponent(roomId);
    await matrixFetch(
      slot.homeserver,
      'POST',
      `/_matrix/client/v3/rooms/${encoded}/leave`,
      {},
      slot.accessToken,
    );
    logger.info({ bot: slot.bot, slot: slot.slot + 1, userId: slot.userId, roomId }, 'BB pool: left room');
  } catch (err) {
    logger.warn({ err, userId: slot.userId, roomId }, 'BB pool: failed to leave room');
  }
}

/** Reset the pool account display name back to a neutral placeholder. */
export async function resetBbDisplayName(slot: BbPoolSlot): Promise<void> {
  try {
    await setBbDisplayName(slot.homeserver, slot.userId, slot.accessToken, `bb${slot.slot + 1}-${slot.bot}`);
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
    format: 'org.matrix.custom.html',
    formatted_body: text,
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
