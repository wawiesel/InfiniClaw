/**
 * Health data collection — pure TypeScript replacement for scripts/health-check.sh.
 * Also replaces scripts/session-cleanup.sh.
 *
 * Collects per-bot health data from log files, session JSONL, and history.
 * Token throughput is computed here from session JSONL files.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { errStr } from './utils.js';

// ── Types ────────────────────────────────────────────────────────────

export interface BotHealthEntry {
  status: 'ACTIVE' | 'RECENT' | 'STALE';
  log_age_min: number;
  error_log_kb: number;
  main_log_kb: number;
  rss_mb: number | null;
  heap_mb: number | null;
  limit_mb: number | null;
  mem_pct: number | null;
  spawns: number;
  sigkills: number;
  sigterms: number;
  oom_kills: number;
  errors: number;
  last_ts: string | null;
}

export interface TokenUsage {
  in_24h: number;
  out_24h: number;
  total_24h: number;
  in_7d: number;
  out_7d: number;
  total_7d: number;
}

export interface SyncStatus {
  status: 'ok' | 'err' | 'unknown';
  last_ok_ts: string | null;   // ISO timestamp of last success
  last_err_ts: string | null;  // ISO timestamp of last failure
  last_err_msg: string | null; // error message (truncated to 200 chars)
}

export interface HealthReport {
  ts: string;
  machine: string;
  bots: Record<string, BotHealthEntry | { error: string }>;
  tokens: Record<string, TokenUsage>;
  sessions: Record<string, number>;
  session_total_mb: number;
  rolling: Record<string, unknown>;
  // Optional beacon fields — populated by relay before S3 upload
  relay_uptime_s?: number;
  secrets_sync?: SyncStatus;
  git_sync?: SyncStatus;
}

// ── Helpers ──────────────────────────────────────────────────────────

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function getRunningContainers(): Set<string> {
  try {
    const out = execSync('podman ps --format "{{.Names}}"', {
      encoding: 'utf-8', timeout: 10_000, stdio: 'pipe',
    });
    const result = new Set<string>();
    for (const line of out.trim().split('\n')) {
      const parts = line.split('-');
      if (parts.length >= 2 && parts[0] === 'nanoclaw') result.add(parts[1]);
    }
    return result;
  } catch {
    return new Set();
  }
}

interface ParsedLogs {
  sigkills: number; sigterms: number; oom_kills: number;
  spawns: number; errors: number;
  lastRss: number | null; lastHeap: number | null;
  limitMb: number | null; lastTs: string | null;
}

function parseLogFiles(logPaths: string[]): ParsedLogs {
  let sigkills = 0, sigterms = 0, oom_kills = 0, spawns = 0, errors = 0;
  let lastRss: number | null = null, lastHeap: number | null = null;
  let limitMb: number | null = null, lastTs: string | null = null;

  for (const logPath of logPaths) {
    if (!fs.existsSync(logPath)) continue;
    for (const line of fs.readFileSync(logPath, 'utf-8').split('\n')) {
      const c = line.replace(ANSI_RE, '');
      if (c.includes('SIGKILL')) sigkills++;
      if (c.includes('SIGTERM')) sigterms++;
      if (c.includes('isOomKill') && c.toLowerCase().includes('true')) oom_kills++;
      if (c.includes('Spawning container')) spawns++;
      if (c.includes('ERROR')) errors++;
      const m1 = c.match(/rssMB.*?(\d+)/); if (m1) lastRss = +m1[1];
      const m2 = c.match(/heapMB.*?(\d+)/); if (m2) lastHeap = +m2[1];
      const m3 = c.match(/limitMB.*?(\d+)/); if (m3 && +m3[1] > 0) limitMb = +m3[1];
      const m4 = c.match(/^\[(\d{2}:\d{2}:\d{2}\.\d+)\]/); if (m4) lastTs = m4[1];
    }
  }
  return { sigkills, sigterms, oom_kills, spawns, errors, lastRss, lastHeap, limitMb, lastTs };
}

function readLastRssFromHistory(historyPath: string): { rssMB?: number; heapMB?: number } | null {
  if (!fs.existsSync(historyPath)) return null;
  try {
    const stat = fs.statSync(historyPath);
    const readSize = Math.min(stat.size, 8192);
    const buf = Buffer.alloc(readSize);
    const fd = fs.openSync(historyPath, 'r');
    fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    fs.closeSync(fd);
    const lines = buf.toString('utf-8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i].trim();
      if (!l) continue;
      try {
        const d = JSON.parse(l) as { rssMB?: number; heapMB?: number };
        if (d.rssMB != null) return d;
      } catch { continue; }
    }
  } catch { /* ignore */ }
  return null;
}

function computeRolling(snapshots: Array<Record<string, unknown>>): Record<string, unknown> | null {
  if (snapshots.length < 2) return null;
  const first = snapshots[0] as { bots?: Record<string, Record<string, number>>; session_total_mb?: number };
  const last = snapshots[snapshots.length - 1] as { bots?: Record<string, Record<string, number>>; session_total_mb?: number };
  const botNames = new Set([...Object.keys(first.bots ?? {}), ...Object.keys(last.bots ?? {})]);

  const bots: Record<string, unknown> = {};
  for (const bot of botNames) {
    const fb = first.bots?.[bot] ?? {};
    const lb = last.bots?.[bot] ?? {};
    if ('error' in fb || 'error' in lb) continue;
    let rss_max = 0;
    for (const s of snapshots) {
      const r = Number((s as { bots?: Record<string, Record<string, unknown>> }).bots?.[bot]?.rss_mb ?? 0);
      if (r > rss_max) rss_max = r;
    }
    bots[bot] = {
      oom_kills: (lb.oom_kills ?? 0) - (fb.oom_kills ?? 0),
      sigkills: (lb.sigkills ?? 0) - (fb.sigkills ?? 0),
      errors: (lb.errors ?? 0) - (fb.errors ?? 0),
      spawns: (lb.spawns ?? 0) - (fb.spawns ?? 0),
      rss_max,
    };
  }
  return {
    snapshots: snapshots.length,
    bots,
    session_delta_mb: ((last.session_total_mb ?? 0) - (first.session_total_mb ?? 0)).toFixed(1),
  };
}

function computeTokens(instancesDir: string, bot: string, now: Date): TokenUsage | null {
  const sessionsPath = path.join(instancesDir, bot, 'data', 'sessions');
  if (!fs.existsSync(sessionsPath)) return null;

  const cutoff24h = new Date(now.getTime() - 24 * 3_600_000);
  const cutoff7d = new Date(now.getTime() - 7 * 86_400_000);
  let in24h = 0, out24h = 0, in7d = 0, out7d = 0, foundAny = false;

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) { walk(fp); continue; }
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      try {
        for (const line of fs.readFileSync(fp, 'utf-8').split('\n')) {
          if (!line.includes('"usage"')) continue;
          let obj: Record<string, unknown>;
          try { obj = JSON.parse(line); } catch { continue; }
          if (obj.type !== 'assistant') continue;
          const usage = ((obj.message as Record<string, unknown>)?.usage ?? {}) as Record<string, unknown>;
          const inp = Number(usage.input_tokens ?? 0);
          const out = Number(usage.output_tokens ?? 0);
          if (inp === 0 && out === 0) continue;
          foundAny = true;
          const ts = new Date(String(obj.timestamp ?? ''));
          if (!isNaN(ts.getTime())) {
            if (ts >= cutoff7d) { in7d += inp; out7d += out; }
            if (ts >= cutoff24h) { in24h += inp; out24h += out; }
          } else {
            in24h += inp; out24h += out; in7d += inp; out7d += out;
          }
        }
      } catch { /* ignore unreadable */ }
    }
  };

  walk(sessionsPath);
  if (!foundAny) return null;
  return { in_24h: in24h, out_24h: out24h, total_24h: in24h + out24h,
           in_7d: in7d, out_7d: out7d, total_7d: in7d + out7d };
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Collect health data for all bots on this ship.
 * Replaces scripts/health-check.sh.
 */
export function collectHealthData(
  logsDir: string,
  instancesDir: string,
  historyFile: string,
  machineName: string,
): HealthReport {
  const now = new Date();
  const running = getRunningContainers();

  const bots = new Set<string>();
  if (fs.existsSync(logsDir)) {
    for (const f of fs.readdirSync(logsDir)) {
      if (f.endsWith('.error.log')) bots.add(f.slice(0, -'.error.log'.length));
    }
  }

  const report: HealthReport = {
    ts: now.toISOString(),
    machine: machineName,
    bots: {},
    tokens: {},
    sessions: {},
    session_total_mb: 0,
    rolling: {},
  };

  for (const bot of [...bots].sort()) {
    const errorLog = path.join(logsDir, `${bot}.error.log`);
    const mainLog = path.join(logsDir, `${bot}.log`);
    if (!fs.existsSync(errorLog)) continue;

    const errorSize = fs.statSync(errorLog).size;
    const mainSize = fs.existsSync(mainLog) ? fs.statSync(mainLog).size : 0;

    try {
      const parsed = parseLogFiles([mainLog, errorLog]);
      let { lastRss, lastHeap, limitMb } = parsed;

      if (lastRss == null) {
        const fallback = readLastRssFromHistory(
          path.join(instancesDir, bot, 'data', 'metrics-history.jsonl')
        );
        if (fallback) { lastRss = fallback.rssMB ?? null; lastHeap = fallback.heapMB ?? null; }
      }

      let logMtime = fs.statSync(errorLog).mtimeMs;
      if (fs.existsSync(mainLog)) logMtime = Math.max(logMtime, fs.statSync(mainLog).mtimeMs);
      const ageMins = (now.getTime() - logMtime) / 60_000;

      const status: BotHealthEntry['status'] =
        running.has(bot) ? 'ACTIVE' :
        (running.size === 0 && ageMins < 5) ? 'ACTIVE' :
        ageMins < 60 ? 'RECENT' : 'STALE';

      report.bots[bot] = {
        status,
        log_age_min: Math.round(ageMins),
        error_log_kb: Math.round(errorSize / 1024),
        main_log_kb: Math.round(mainSize / 1024),
        rss_mb: lastRss,
        heap_mb: lastHeap,
        limit_mb: limitMb,
        mem_pct: lastRss != null && limitMb != null ? Math.round(lastRss / limitMb * 100) : null,
        spawns: parsed.spawns,
        sigkills: parsed.sigkills,
        sigterms: parsed.sigterms,
        oom_kills: parsed.oom_kills,
        errors: parsed.errors,
        last_ts: parsed.lastTs,
      };
    } catch (err) {
      report.bots[bot] = { error: errStr(err) };
    }
  }

  // Session sizes
  let totalSessionBytes = 0;
  if (fs.existsSync(instancesDir)) {
    for (const botDir of fs.readdirSync(instancesDir)) {
      const botPath = path.join(instancesDir, botDir);
      if (!fs.statSync(botPath).isDirectory()) continue;
      let size = 0;
      const walkSize = (dir: string): void => {
        try {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const fp = path.join(dir, e.name);
            if (e.isSymbolicLink()) continue;
            if (e.isDirectory()) walkSize(fp);
            else { try { size += fs.statSync(fp).size; } catch { /* ignore */ } }
          }
        } catch { /* ignore */ }
      };
      walkSize(botPath);
      report.sessions[botDir] = Math.round(size / 1024 / 1024 * 10) / 10;
      totalSessionBytes += size;
    }
  }
  report.session_total_mb = Math.round(totalSessionBytes / 1024 / 1024 * 10) / 10;

  // Token throughput from session JSONL files
  for (const bot of [...bots].sort()) {
    const tok = computeTokens(instancesDir, bot, now);
    if (tok) report.tokens[bot] = tok;
  }

  // Rolling metrics from history
  if (fs.existsSync(historyFile)) {
    const cutoff24h = new Date(now.getTime() - 24 * 3_600_000);
    const cutoff7d = new Date(now.getTime() - 7 * 86_400_000);
    const snaps24h: Array<Record<string, unknown>> = [];
    const snaps7d: Array<Record<string, unknown>> = [];
    try {
      for (const line of fs.readFileSync(historyFile, 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const snap = JSON.parse(line) as Record<string, unknown>;
          const ts = new Date(String(snap.ts));
          if (ts >= cutoff7d) snaps7d.push(snap);
          if (ts >= cutoff24h) snaps24h.push(snap);
        } catch { continue; }
      }
    } catch { /* ignore */ }
    const r24 = computeRolling(snaps24h);
    const r7d = computeRolling(snaps7d);
    if (r24) report.rolling['24h'] = r24;
    if (r7d) report.rolling['7d'] = r7d;
  }

  return report;
}

/**
 * Prune old session JSONL files and ephemeral directories.
 * Replaces scripts/session-cleanup.sh.
 * Returns total bytes freed and list of cleaned paths.
 */
export function sessionCleanup(instancesDir: string, keep = 5): { freedBytes: number; cleaned: string[] } {
  let freedBytes = 0;
  const cleaned: string[] = [];
  if (!fs.existsSync(instancesDir)) return { freedBytes, cleaned };

  const duSize = (dir: string): number => {
    let total = 0;
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) total += duSize(fp);
        else { try { total += fs.statSync(fp).size; } catch { /* ignore */ } }
      }
    } catch { /* ignore */ }
    return total;
  };

  for (const botDir of fs.readdirSync(instancesDir)) {
    const sessionsBase = path.join(instancesDir, botDir, 'data', 'sessions');
    if (!fs.existsSync(sessionsBase)) continue;

    // Remove telemetry/ and debug/ directories
    for (const ephemeral of ['telemetry', 'debug']) {
      const walk = (dir: string): void => {
        try {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const fp = path.join(dir, e.name);
            if (!e.isDirectory()) continue;
            if (e.name === ephemeral) {
              freedBytes += duSize(fp);
              fs.rmSync(fp, { recursive: true, force: true });
              cleaned.push(`${botDir}/${ephemeral}`);
            } else {
              walk(fp);
            }
          }
        } catch { /* ignore */ }
      };
      walk(sessionsBase);
    }

    // Prune old .jsonl files in .claude/projects subdirs (keep newest N)
    const walkProjects = (dir: string): void => {
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!e.isDirectory()) continue;
          const fp = path.join(dir, e.name);
          if (e.name === 'projects') {
            // Each subdir within projects has .jsonl files
            try {
              for (const sub of fs.readdirSync(fp, { withFileTypes: true })) {
                if (!sub.isDirectory()) continue;
                const subPath = path.join(fp, sub.name);
                const jsonls = fs.readdirSync(subPath)
                  .filter(f => f.endsWith('.jsonl') && !f.endsWith('.tmp'))
                  .map(f => {
                    const full = path.join(subPath, f);
                    return { full, mtime: fs.statSync(full).mtimeMs };
                  })
                  .sort((a, b) => a.mtime - b.mtime); // oldest first
                if (jsonls.length > keep) {
                  for (const f of jsonls.slice(0, jsonls.length - keep)) {
                    const size = fs.statSync(f.full).size;
                    fs.unlinkSync(f.full);
                    freedBytes += size;
                    cleaned.push(`${botDir}/${path.basename(f.full)}`);
                  }
                }
              }
            } catch { /* ignore */ }
          } else {
            walkProjects(fp);
          }
        }
      } catch { /* ignore */ }
    };
    walkProjects(sessionsBase);
  }

  return { freedBytes, cleaned };
}
