#!/usr/bin/env npx tsx
/**
 * ic01-harness.ts — IC01 E2E test harness
 *
 * Sends Matrix events to IC01, captures responses, and asserts outcomes.
 * Run with: npx tsx scripts/ic01-harness.ts
 *
 * Env:
 *   IC01_TIMEOUT_SEC   default wait timeout per test in seconds (default: 30)
 *   IC01_POLL_MS       polling interval in ms (default: 2000)
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import {
  matrixLogin,
  matrixLogout,
  matrixSend,
  matrixSync,
  type IntercomConfig,
} from '../src/matrix-api.js';

// ── Config ────────────────────────────────────────────────────────────

const SECRETS = join(homedir(), '.config', 'infiniclaw', 'secrets');
const INTERCOM_PATH = join(SECRETS, 'operator', 'intercom01.json');
const TIMEOUT_MS = (Number(process.env['IC01_TIMEOUT_SEC'] ?? 30)) * 1_000;
const POLL_MS = Number(process.env['IC01_POLL_MS'] ?? 2_000);

// ── Types ─────────────────────────────────────────────────────────────

interface RoomEntry { roomId: string; username: string; password: string; }

interface Session {
  homeserver: string;
  token: string;
  userId: string;
  rooms: Record<string, RoomEntry>;
}

interface TestResult { name: string; passed: boolean; error?: string; durationMs: number; }

// ── Matrix helpers ────────────────────────────────────────────────────

/**
 * Send a text message to a named IC01 room (e.g. "engineering").
 * Returns the sent event_id.
 */
export async function send(session: Session, roomKey: string, text: string): Promise<string> {
  const room = resolveRoom(session, roomKey);
  const eventId = await matrixSend({
    homeserver: session.homeserver,
    token: session.token,
    roomId: room.roomId,
    text,
    plain: true,
  });
  if (!eventId) throw new Error(`matrixSend failed for room "${roomKey}"`);
  return eventId;
}

/**
 * Poll a room until a non-own message matches `matcher`, or timeout.
 * Returns the matching message body, or null on timeout.
 */
export async function waitFor(
  session: Session,
  roomKey: string,
  matcher: RegExp | ((body: string) => boolean),
  opts?: { timeoutMs?: number; afterTs?: number },
): Promise<string | null> {
  const room = resolveRoom(session, roomKey);
  const deadline = Date.now() + (opts?.timeoutMs ?? TIMEOUT_MS);
  const afterTs = opts?.afterTs ?? Date.now();

  // Snapshot sync position
  const initial = await matrixSync(session.homeserver, session.token, null, null, 0);
  let syncToken = initial.next_batch;

  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const data = await matrixSync(session.homeserver, session.token, syncToken, null, 5_000);
    syncToken = data.next_batch;

    for (const event of data.rooms?.join?.[room.roomId]?.timeline?.events ?? []) {
      if (event.type !== 'm.room.message') continue;
      if (event.sender === session.userId) continue;       // skip own echo
      if (event.origin_server_ts < afterTs) continue;     // skip pre-existing events
      const body = String(event.content?.body ?? '');
      const matched = matcher instanceof RegExp ? matcher.test(body) : matcher(body);
      if (matched) return body;
    }
  }
  return null;
}

// ── Assertions ────────────────────────────────────────────────────────

export function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

export function assertMatch(body: string | null, pattern: RegExp, label: string): void {
  assert(body !== null, `${label}: no response received within timeout`);
  assert(pattern.test(body!), `${label}: response did not match ${pattern}\n  Got: ${preview(body!)}`);
}

// ── Test runner ───────────────────────────────────────────────────────

type TestFn = (session: Session) => Promise<void>;
const registry: Array<{ name: string; fn: TestFn }> = [];

export function test(name: string, fn: TestFn): void {
  registry.push({ name, fn });
}

async function runAll(session: Session): Promise<void> {
  const results: TestResult[] = [];
  let passed = 0;

  for (const { name, fn } of registry) {
    const start = Date.now();
    try {
      await fn(session);
      const durationMs = Date.now() - start;
      results.push({ name, passed: true, durationMs });
      console.log(`  ✓ ${name} (${durationMs}ms)`);
      passed++;
    } catch (err) {
      const durationMs = Date.now() - start;
      const error = err instanceof Error ? err.message : String(err);
      results.push({ name, passed: false, error, durationMs });
      console.log(`  ✗ ${name} (${durationMs}ms)`);
      console.log(`    ${error}`);
    }
  }

  const total = results.length;
  const failed = total - passed;
  console.log(`\n${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}`);

  if (failed > 0) process.exit(1);
}

// ── Smoke tests ───────────────────────────────────────────────────────
// WBS 17.1: scaffold smoke test — validates harness wiring end-to-end.
// Tests 17.2–17.8 will be added as separate test() blocks.

test('smoke: !fleet returns fleet data', async (session) => {
  const sentAt = Date.now();
  await send(session, 'engineering', '!fleet');
  const body = await waitFor(
    session,
    'engineering',
    /fleet|infiniclaw|nanoclaw|IC0[01]|🟢|🔴|🟡|online|offline/i,
    { afterTs: sentAt },
  );
  assertMatch(body, /fleet|infiniclaw|nanoclaw|IC0[01]|🟢|🔴|🟡|online|offline/i, '!fleet');
});

// WBS 17.3: tool output uses S3 breadcrumbs, not inline details blocks
test('tool output: S3 breadcrumbs, no inline <details>', async (session) => {
  const sentAt = Date.now();
  // !wbs triggers a tool call (reads WBS from storage) — any tool-bearing command works
  await send(session, 'engineering', '!wbs');
  // Capture the first bot message that contains the 🔧 tool-call indicator
  const body = await waitFor(
    session,
    'engineering',
    (b) => b.includes('🔧'),
    { afterTs: sentAt },
  );
  assert(body !== null, 'tool output: no 🔧 tool message observed within timeout');
  // Must NOT be a raw inline <details> block (isToolCallBlock pattern)
  const isInlineBlock = body!.trimStart().startsWith('<details>') && body!.includes('🔧');
  assert(
    !isInlineBlock,
    `tool output: inline <details> block posted to room — expected S3 breadcrumb\n  Got: ${preview(body!)}`,
  );
  // Must be a compact breadcrumb: 🔧 wrapped in a <font> tag
  assertMatch(body, /<font[^>]*>.*🔧|🔧.*<\/font>/i, 'tool output: S3 breadcrumb format');
});

// ── Entrypoint ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Preflight
  let intercom: IntercomConfig;
  try {
    intercom = JSON.parse(readFileSync(INTERCOM_PATH, 'utf-8')) as IntercomConfig;
  } catch {
    console.error(`FAIL: cannot read intercom01.json at ${INTERCOM_PATH}`);
    process.exit(1);
  }

  const { homeserver, rooms } = intercom;
  const eng = rooms['engineering'] ?? rooms['Engineering'];
  if (!eng) {
    console.error('FAIL: no "engineering" room in intercom01.json');
    process.exit(1);
  }

  // Login
  const { accessToken, userId } = await matrixLogin(homeserver, eng.username, eng.password);
  const session: Session = { homeserver, token: accessToken, userId, rooms };

  console.log(`ic01-harness: ${registry.length} test(s) — ${userId}`);

  try {
    await runAll(session);
  } finally {
    await matrixLogout(homeserver, accessToken).catch(() => {});
  }
}

main().catch((err) => {
  console.error('ic01-harness error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

// ── Utilities ─────────────────────────────────────────────────────────

function resolveRoom(session: Session, key: string): RoomEntry {
  const room = session.rooms[key] ?? session.rooms[capitalize(key)];
  if (!room) throw new Error(`Room "${key}" not found in intercom01.json`);
  return room;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function preview(s: string, max = 200): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
