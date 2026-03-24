/**
 * Alignment harness — pre-deployment verification gate.
 *
 * Two modes:
 * - Static: fast checks (commit hygiene) — used by !wake pre-deploy gate
 * - Full: static + interactive tests against a running bot's DB
 *
 * Design: docs/design/27-alignment.md
 * WBS: 18.1, 18.8
 */
import { execSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import {
  resolveRoot,
  instanceDir,
} from './service.js';
import { logger } from 'nanoclaw/logger.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface AlignmentResult {
  name: string;
  passed: boolean;
  evidence: string;
}

export interface AlignmentReport {
  bot: string;
  branch: string;
  timestamp: string;
  results: AlignmentResult[];
  passed: boolean;
}

interface AlignmentTest {
  name: string;
  fn: (ctx: TestContext) => Promise<AlignmentResult>;
}

interface TestContext {
  bot: string;
  branch: string;
  hdBot: string;
  dbPath: string;
  root: string;
}

// ── Helpers ────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function hdBotName(bot: string): string {
  return `${bot}-alignment`;
}

/** Inject a message into the sandbox bot's message DB. */
function injectMessage(dbPath: string, message: string): string {
  const db = new Database(dbPath);
  try {
    const msgId = `align-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const timestamp = new Date().toISOString();
    const jidRow = db.prepare('SELECT jid FROM registered_groups LIMIT 1').get() as { jid: string } | undefined;
    const jid = jidRow?.jid || 'local:terminal';
    db.prepare(
      'INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?, ?, 0)',
    ).run(msgId, jid, 'operator', 'Captain', message, timestamp);
    return msgId;
  } finally {
    db.close();
  }
}

/** Read recent messages from sandbox bot's message DB. */
function readMessages(dbPath: string, limit = 50): Array<{ sender_name: string; content: string; timestamp: string; is_from_me: number }> {
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(
      'SELECT sender_name, content, timestamp, is_from_me FROM messages ORDER BY timestamp DESC LIMIT ?',
    ).all(limit) as Array<{ sender_name: string; content: string; timestamp: string; is_from_me: number }>;
  } finally {
    db.close();
  }
}

/** Wait for sandbox bot to be responsive (produces at least one is_from_me message). */
async function waitForReady(dbPath: string, timeoutMs = 60_000, pollMs = 3_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const msgs = readMessages(dbPath, 10);
    if (msgs.some((m) => m.is_from_me === 1)) return true;
    await sleep(pollMs);
  }
  return false;
}

/** Send a message and wait for a bot response after it. */
async function sendAndWait(
  dbPath: string,
  message: string,
  timeoutMs = 30_000,
  pollMs = 2_000,
): Promise<Array<{ sender_name: string; content: string; timestamp: string }>> {
  const beforeCount = readMessages(dbPath, 200).filter((m) => m.is_from_me === 1).length;
  injectMessage(dbPath, message);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(pollMs);
    const msgs = readMessages(dbPath, 200);
    const botMsgs = msgs.filter((m) => m.is_from_me === 1);
    if (botMsgs.length > beforeCount) {
      // Return new bot messages
      return botMsgs.slice(0, botMsgs.length - beforeCount).reverse();
    }
  }
  return [];
}

// ── Test Cases ─────────────────────────────────────────────────────────

/** WBS 18.7: No Co-Authored-By in commits on the branch. */
async function testNoCoAuthoredBy(ctx: TestContext): Promise<AlignmentResult> {
  const name = 'commit-hygiene';
  try {
    const log = execSync(`git log --format=%B origin/main..${ctx.branch}`, {
      cwd: ctx.root,
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim();
    if (!log) {
      return { name, passed: true, evidence: 'No new commits on branch vs main.' };
    }
    const hasCoAuthored = /Co-Authored-By:/i.test(log);
    return {
      name,
      passed: !hasCoAuthored,
      evidence: hasCoAuthored
        ? 'Found Co-Authored-By in commit messages on branch.'
        : `Checked ${log.split('\n\n').length} commit(s) — no Co-Authored-By found.`,
    };
  } catch (err) {
    return { name, passed: false, evidence: `Error checking commits: ${err}` };
  }
}

/** WBS 18.3: Bot responds to commands (!health, !fleet, !wbs). */
async function testCommandHandling(ctx: TestContext): Promise<AlignmentResult> {
  const name = 'command-handling';
  const commands = ['!health', '!fleet', '!wbs'];
  const failures: string[] = [];

  for (const cmd of commands) {
    const responses = await sendAndWait(ctx.dbPath, cmd, 45_000);
    if (responses.length === 0) {
      failures.push(`${cmd}: no response within 45s`);
    }
  }

  if (failures.length > 0) {
    return { name, passed: false, evidence: `Failed: ${failures.join('; ')}` };
  }
  return {
    name,
    passed: true,
    evidence: `All ${commands.length} commands (!health, !fleet, !wbs) received responses.`,
  };
}

/** WBS 18.4: Tool output should not contain raw <details> blocks. */
async function testNoBareDetails(ctx: TestContext): Promise<AlignmentResult> {
  const name = 's3-breadcrumbs';
  const msgs = readMessages(ctx.dbPath, 100);
  const botMsgs = msgs.filter((m) => m.is_from_me === 1);
  const withDetails = botMsgs.filter((m) => /<details>/i.test(m.content));
  if (withDetails.length > 0) {
    return {
      name,
      passed: false,
      evidence: `Found ${withDetails.length} bot message(s) with <details> blocks.`,
    };
  }
  return {
    name,
    passed: true,
    evidence: `Checked ${botMsgs.length} bot message(s) — no raw <details> blocks.`,
  };
}

/** WBS 18.2: {{branch}} signal creates BB — bot dispatches via branch signal for multi-step tasks. */
async function testBranchSignal(ctx: TestContext): Promise<AlignmentResult> {
  const name = 'branch-signal';
  // Ask the bot to do a multi-step task that should trigger {{branch}} dispatch
  const responses = await sendAndWait(
    ctx.dbPath,
    'Investigate the alignment test infrastructure in src/alignment.ts, find any bugs, and fix them.',
    60_000,
    3_000,
  );
  if (responses.length === 0) {
    return { name, passed: false, evidence: 'Bot did not respond to multi-step task within 60s.' };
  }
  // Check if any response contains the {{branch signal
  const allContent = responses.map((r) => r.content).join('\n');
  const hasBranch = /\{\{branch\s/.test(allContent);
  return {
    name,
    passed: hasBranch,
    evidence: hasBranch
      ? `Bot dispatched via {{branch}} signal. Response: "${allContent.slice(0, 150)}"`
      : `Bot responded but did not use {{branch}} signal. Response: "${allContent.slice(0, 150)}"`,
  };
}

/** WBS 18.5: Thread routing — replies stay in thread, no main timeline bleed. */
async function testThreadRouting(ctx: TestContext): Promise<AlignmentResult> {
  const name = 'thread-routing';
  const msgs = readMessages(ctx.dbPath, 200);
  const botMsgs = msgs.filter((m) => m.is_from_me === 1);
  const contentCounts = new Map<string, number>();
  for (const m of botMsgs) {
    const key = m.content.trim().slice(0, 200);
    contentCounts.set(key, (contentCounts.get(key) || 0) + 1);
  }
  const dupes = [...contentCounts.entries()].filter(([, count]) => count > 1);
  if (dupes.length > 0) {
    return {
      name,
      passed: false,
      evidence: `Found ${dupes.length} duplicate bot message(s) — possible thread bleed.`,
    };
  }
  return {
    name,
    passed: true,
    evidence: `Checked ${botMsgs.length} bot message(s) — no duplicate content detected.`,
  };
}

/** WBS 18.6: {{send}} cross-room routing delivers to target room. */
async function testSendRouting(ctx: TestContext): Promise<AlignmentResult> {
  const name = 'send-routing';
  const responses = await sendAndWait(
    ctx.dbPath,
    'Send a one-line status update to the bridge room.',
    45_000,
  );
  if (responses.length === 0) {
    return { name, passed: false, evidence: 'Bot did not respond to cross-room send request within 45s.' };
  }
  const allContent = responses.map((r) => r.content).join('\n');
  const hasSend = /\{\{send\s/.test(allContent);
  return {
    name,
    passed: hasSend,
    evidence: hasSend
      ? `Bot used {{send}} signal for cross-room routing.`
      : `Bot responded but did not use {{send}} signal. Response: "${allContent.slice(0, 150)}"`,
  };
}

/** Basic boot test: bot starts and produces output. */
async function testBotBoot(ctx: TestContext): Promise<AlignmentResult> {
  const name = 'bot-boot';
  const ready = await waitForReady(ctx.dbPath, 60_000);
  if (!ready) {
    return { name, passed: false, evidence: 'Bot did not produce any output within 60s of boot.' };
  }
  return { name, passed: true, evidence: 'Bot booted and produced output.' };
}

// ── Test Registry ──────────────────────────────────────────────────────

/** Static tests — no running bot needed, safe for !wake pre-deploy gate. */
const STATIC_TESTS: AlignmentTest[] = [
  { name: 'commit-hygiene', fn: testNoCoAuthoredBy },
];

/** Interactive tests — need a running bot's message DB. */
const INTERACTIVE_TESTS: AlignmentTest[] = [
  { name: 'bot-boot', fn: testBotBoot },
  { name: 'branch-signal', fn: testBranchSignal },
  { name: 'command-handling', fn: testCommandHandling },
  { name: 's3-breadcrumbs', fn: testNoBareDetails },
  { name: 'thread-routing', fn: testThreadRouting },
  { name: 'send-routing', fn: testSendRouting },
];

// ── Runners ────────────────────────────────────────────────────────────

/** Run a list of tests and collect results into a report. */
async function runTests(tests: AlignmentTest[], ctx: TestContext, report: AlignmentReport): Promise<void> {
  for (const test of tests) {
    try {
      const result = await test.fn(ctx);
      report.results.push(result);
      logger.info({ test: test.name, passed: result.passed }, 'Alignment test complete');
      if (test.name === 'bot-boot' && !result.passed) break;
    } catch (err) {
      report.results.push({
        name: test.name,
        passed: false,
        evidence: `Uncaught error: ${err}`,
      });
    }
  }
}

/**
 * Static alignment — fast pre-deploy checks, no running bot needed.
 * Used by !wake to gate deployments.
 */
export function runStaticAlignment(branch: string): AlignmentReport {
  const root = resolveRoot();
  const report: AlignmentReport = {
    bot: 'static',
    branch,
    timestamp: new Date().toISOString(),
    results: [],
    passed: false,
  };

  logger.info({ branch }, 'Static alignment: starting');

  const ctx: TestContext = { bot: 'static', branch, hdBot: '', dbPath: '', root };
  for (const test of STATIC_TESTS) {
    try {
      if (test.name === 'commit-hygiene') {
        const log = execSync(`git log --format=%B origin/main..${branch}`, {
          cwd: root,
          encoding: 'utf-8',
          timeout: 10_000,
        }).trim();
        if (!log) {
          report.results.push({ name: test.name, passed: true, evidence: 'No new commits on branch vs main.' });
        } else {
          const hasCoAuthored = /Co-Authored-By:/i.test(log);
          report.results.push({
            name: test.name,
            passed: !hasCoAuthored,
            evidence: hasCoAuthored
              ? 'Found Co-Authored-By in commit messages on branch.'
              : `Checked ${log.split('\n\n').length} commit(s) — no Co-Authored-By found.`,
          });
        }
      }
    } catch (err) {
      report.results.push({ name: test.name, passed: false, evidence: `Error: ${err}` });
    }
  }

  report.passed = report.results.length > 0 && report.results.every((r) => r.passed);
  logger.info({ branch, passed: report.passed, tests: report.results.length }, 'Static alignment: complete');
  return report;
}

/**
 * Full alignment — static + interactive tests against a bot's message DB.
 * Used by alignment_run IPC command and run_alignment MCP tool.
 */
export async function runAlignment(bot: string, branch: string): Promise<AlignmentReport> {
  const root = resolveRoot();
  const dbPath = path.join(instanceDir(root, bot), 'store', 'messages.db');

  const report: AlignmentReport = {
    bot,
    branch,
    timestamp: new Date().toISOString(),
    results: [],
    passed: false,
  };

  logger.info({ bot, branch }, 'Alignment: starting');

  // 1. Run static tests first
  const ctx: TestContext = { bot, branch, hdBot: hdBotName(bot), dbPath, root };
  await runTests(STATIC_TESTS, ctx, report);

  // Bail early if static tests failed
  if (report.results.some((r) => !r.passed)) {
    report.passed = false;
    return report;
  }

  // 2. Run interactive tests if bot DB exists
  if (!fs.existsSync(dbPath)) {
    report.results.push({
      name: 'setup',
      passed: false,
      evidence: `Bot DB not found at ${dbPath} — bot may not be running.`,
    });
    report.passed = false;
    return report;
  }

  await runTests(INTERACTIVE_TESTS, ctx, report);

  report.passed = report.results.length > 0 && report.results.every((r) => r.passed);
  logger.info({ bot, branch, passed: report.passed, tests: report.results.length }, 'Alignment: complete');
  return report;
}

/** Format an alignment report for human display. */
export function formatReport(report: AlignmentReport): string {
  const icon = report.passed ? '✅' : '❌';
  const lines = [
    `${icon} **Alignment: ${report.bot}** (${report.branch})`,
    '',
  ];
  for (const r of report.results) {
    lines.push(`${r.passed ? '✅' : '❌'} **${r.name}** — ${r.evidence}`);
  }
  return lines.join('\n');
}
