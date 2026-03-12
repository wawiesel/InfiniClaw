/**
 * Health check and session cleanup — public API wrappers.
 *
 * Wraps the internal implementation in health-check.ts with the
 * simplified interface expected by relay.ts and ipc-commands.ts.
 * Uses Node.js built-ins only (fs, path, child_process via health-check.ts).
 */
import os from 'os';
import path from 'path';

import { logger } from 'nanoclaw/logger.js';

import {
  collectHealthData,
  sessionCleanup,
  type BotHealthEntry,
  type HealthReport as InternalHealthReport,
} from './health-check.js';
import { resolveRoot } from './service.js';

// ── Public types ─────────────────────────────────────────────────────

/** Per-bot health data as collected from logs and process state. */
export type BotHealthData = BotHealthEntry & { error?: string };

/** Full health report for this ship. */
export interface HealthReport {
  ts: string;
  machine: string;
  bots: Record<string, BotHealthData>;
  sessions: Record<string, number>; // bot → MB
  session_total_mb: number;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Run a health check on all bots on this machine.
 * Never throws — all errors are caught internally.
 */
export function runHealthCheck(machineName?: string): HealthReport {
  const root = resolveRoot();
  const report: InternalHealthReport = collectHealthData(
    path.join(root, '_runtime', 'logs'),
    path.join(root, '_runtime', 'instances'),
    path.join(root, '_runtime', 'data', 'health-history.jsonl'),
    machineName ?? os.hostname(),
  );
  return {
    ts: report.ts,
    machine: report.machine,
    bots: report.bots as Record<string, BotHealthData>,
    sessions: report.sessions,
    session_total_mb: report.session_total_mb,
  };
}

/**
 * Prune old Claude Code session files and ephemeral data.
 * Replaces scripts/session-cleanup.sh.
 */
export function runSessionCleanup(keep = 5): void {
  const root = resolveRoot();
  const { freedBytes } = sessionCleanup(
    path.join(root, '_runtime', 'instances'),
    keep,
  );
  if (freedBytes > 0) {
    logger.info(`session cleanup: freed ~${Math.round(freedBytes / 1024)}KB`);
  }
}
