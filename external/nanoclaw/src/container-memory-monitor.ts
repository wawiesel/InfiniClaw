/**
 * Container Memory Monitor
 *
 * Polls `podman stats` periodically for named nanoclaw containers.
 * Maintains a rolling ring-buffer of snapshots so that when a container
 * dies with exit 137 (SIGKILL) we can check whether it was near its
 * memory limit at the time, helping distinguish OOM kills from external kills.
 */
import { execSync } from 'child_process';

import { logger } from './logger.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface MemorySnapshot {
  containerName: string;
  timestamp: number; // Unix ms
  usedBytes: number;
  limitBytes: number;
  usedPercent: number; // 0–100
}

// ── Constants ────────────────────────────────────────────────────────────────

/** How often to poll podman stats (ms). */
const POLL_INTERVAL_MS = 10_000;

/** Max snapshots retained per container (ring buffer). 10s × 180 = 30 min of history. */
const MAX_SNAPSHOTS_PER_CONTAINER = 180;

/** Percentage threshold above which we consider a container "near limit". */
export const MEMORY_NEAR_LIMIT_PCT = 85;

// ── State ────────────────────────────────────────────────────────────────────

/** Ring buffer: containerName → ordered array of snapshots (oldest first). */
const ringBuffer = new Map<string, MemorySnapshot[]>();

let pollTimer: ReturnType<typeof setInterval> | null = null;

// ── Internal helpers ─────────────────────────────────────────────────────────

/** Parse `podman stats --no-stream --format json` output into snapshots. */
function parseStatsJson(raw: string, now: number): MemorySnapshot[] {
  let rows: Record<string, string>[];
  try {
    rows = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];

  const snapshots: MemorySnapshot[] = [];
  for (const row of rows) {
    // Podman JSON field names vary by version. Handle both camelCase and PascalCase.
    const name: string = (row['Name'] ?? row['name'] ?? '').toString();
    if (!name) continue;

    // MemUsage field: "1.23GiB / 6GiB" or "123MiB / 6.00GiB"
    const memUsage: string = (row['MemUsage'] ?? row['mem_usage'] ?? '').toString();
    const memPerc: string = (row['MemPerc'] ?? row['mem_perc'] ?? '0%').toString();

    const { used, limit } = parseMemUsage(memUsage);
    const pct = parseFloat(memPerc.replace('%', '')) || 0;

    if (limit === 0) continue; // container not found or no limit data

    snapshots.push({
      containerName: name,
      timestamp: now,
      usedBytes: used,
      limitBytes: limit,
      usedPercent: pct,
    });
  }
  return snapshots;
}

/** Parse "1.23GiB / 6GiB" → { used, limit } in bytes. */
function parseMemUsage(raw: string): { used: number; limit: number } {
  const parts = raw.split('/').map((s) => s.trim());
  if (parts.length < 2) return { used: 0, limit: 0 };
  return {
    used: parseHumanBytes(parts[0]),
    limit: parseHumanBytes(parts[1]),
  };
}

/** Convert "1.23GiB", "512MiB", "2GB", etc. to bytes. */
function parseHumanBytes(s: string): number {
  const m = s.match(/^([\d.]+)\s*([a-zA-Z]*)/);
  if (!m) return 0;
  const val = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  const units: Record<string, number> = {
    b: 1,
    kb: 1e3, kib: 1024,
    mb: 1e6, mib: 1024 ** 2,
    gb: 1e9, gib: 1024 ** 3,
    tb: 1e12, tib: 1024 ** 4,
  };
  return Math.round(val * (units[unit] ?? 1));
}

/** Store snapshot into the container's ring buffer. */
function storeSnapshot(snap: MemorySnapshot): void {
  let buf = ringBuffer.get(snap.containerName);
  if (!buf) {
    buf = [];
    ringBuffer.set(snap.containerName, buf);
  }
  buf.push(snap);
  if (buf.length > MAX_SNAPSHOTS_PER_CONTAINER) {
    buf.shift(); // drop oldest
  }
}

/** Run one poll cycle. */
function poll(): void {
  try {
    // Only poll containers whose name matches our naming scheme
    const raw = execSync('podman stats --no-stream --format json 2>/dev/null', {
      timeout: 8_000,
      encoding: 'utf8',
    });
    const now = Date.now();
    const snapshots = parseStatsJson(raw, now);
    for (const snap of snapshots) {
      storeSnapshot(snap);
    }
    if (snapshots.length > 0) {
      logger.debug(
        { containers: snapshots.map((s) => `${s.containerName}=${s.usedPercent.toFixed(1)}%`) },
        'Memory monitor poll',
      );
    }
  } catch {
    // podman may not be available or no containers running — silently ignore
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start the global polling loop (idempotent — safe to call multiple times).
 */
export function startMemoryMonitor(): void {
  if (pollTimer !== null) return;
  // Run immediately, then on interval
  poll();
  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  logger.info({ intervalMs: POLL_INTERVAL_MS }, 'Container memory monitor started');
}

/**
 * Stop the global polling loop.
 */
export function stopMemoryMonitor(): void {
  if (pollTimer === null) return;
  clearInterval(pollTimer);
  pollTimer = null;
  logger.info('Container memory monitor stopped');
}

/**
 * Remove all stored snapshots for a container (call after container exits
 * and you have finished correlating).
 */
export function evictContainer(containerName: string): void {
  ringBuffer.delete(containerName);
}

/**
 * Return the most recent memory snapshot for a container, or null if none.
 */
export function getLatestSnapshot(containerName: string): MemorySnapshot | null {
  const buf = ringBuffer.get(containerName);
  if (!buf || buf.length === 0) return null;
  return buf[buf.length - 1];
}

/**
 * Return all stored snapshots for a container (oldest first).
 */
export function getSnapshots(containerName: string): MemorySnapshot[] {
  return ringBuffer.get(containerName) ?? [];
}

/**
 * Analyse exit-137 context for a container.
 * Returns a human-readable verdict and structured data for logging.
 */
export interface OomAnalysis {
  /** "likely_oom" | "likely_external_kill" | "insufficient_data" */
  verdict: 'likely_oom' | 'likely_external_kill' | 'insufficient_data';
  /** Most recent memory percent before exit (if available). */
  lastUsedPercent?: number;
  /** Peak memory percent in the last N snapshots. */
  peakUsedPercent?: number;
  /** Human-readable summary. */
  summary: string;
}

export function analyseExit137(containerName: string): OomAnalysis {
  const snapshots = getSnapshots(containerName);

  if (snapshots.length === 0) {
    return {
      verdict: 'insufficient_data',
      summary: `No memory snapshots recorded for container ${containerName}. Cannot determine if exit 137 was OOM or external kill.`,
    };
  }

  const last = snapshots[snapshots.length - 1];
  const peakUsedPercent = Math.max(...snapshots.map((s) => s.usedPercent));
  const lastUsedPercent = last.usedPercent;
  const ageSec = Math.round((Date.now() - last.timestamp) / 1000);

  // If latest snapshot is too stale (e.g. container died long before next poll)
  if (ageSec > POLL_INTERVAL_MS / 1000 * 3) {
    return {
      verdict: 'insufficient_data',
      lastUsedPercent,
      peakUsedPercent,
      summary:
        `Latest snapshot for ${containerName} is ${ageSec}s old (stale). ` +
        `Last recorded: ${lastUsedPercent.toFixed(1)}%, peak: ${peakUsedPercent.toFixed(1)}%.`,
    };
  }

  const nearLimit = lastUsedPercent >= MEMORY_NEAR_LIMIT_PCT || peakUsedPercent >= MEMORY_NEAR_LIMIT_PCT;

  const limitMb = Math.round(last.limitBytes / 1024 / 1024);
  const usedMb = Math.round(last.usedBytes / 1024 / 1024);

  if (nearLimit) {
    return {
      verdict: 'likely_oom',
      lastUsedPercent,
      peakUsedPercent,
      summary:
        `Container ${containerName} was at ${lastUsedPercent.toFixed(1)}% memory ` +
        `(${usedMb}MB / ${limitMb}MB limit) before exit. Peak: ${peakUsedPercent.toFixed(1)}%. ` +
        `Exit 137 is likely an OOM kill.`,
    };
  }

  return {
    verdict: 'likely_external_kill',
    lastUsedPercent,
    peakUsedPercent,
    summary:
      `Container ${containerName} was at only ${lastUsedPercent.toFixed(1)}% memory ` +
      `(${usedMb}MB / ${limitMb}MB limit) before exit. Peak: ${peakUsedPercent.toFixed(1)}%. ` +
      `Exit 137 was likely an external SIGKILL, not OOM.`,
  };
}
