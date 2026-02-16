/**
 * NanoClaw Status — Core status gathering module
 * Read-only: opens its own SQLite connection, shells out to launchctl/podman.
 */
import { execSync } from 'child_process';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

// ── Types ──────────────────────────────────────────────────────────

export interface ContainerInfo {
  name: string;
  group: string;
  uptime: string;
}

export interface GroupStatus {
  jid: string;
  name: string;
  folder: string;
  lastActivity?: string;
  currentObjective?: string;
  lastProgress?: string;
  lastProgressAt?: string;
  lastError?: string;
  lastErrorAt?: string;
  sessionId?: string;
  containerLogDir?: string;
}

export interface TaskStatus {
  id: string;
  prompt: string;
  schedule: string;
  status: string;
  nextRun?: string;
  lastRun?: string;
}

export interface TokenUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUSD?: number;
}

export interface BotLogFiles {
  stdout: string;
  stderr: string;
  containerLogs: string;
  db: string;
}

export interface BotStatus {
  name: string;
  service: 'running' | 'stopped';
  pid?: number;
  model?: string;
  provider?: string;
  containers: ContainerInfo[];
  groups: GroupStatus[];
  tasks: TaskStatus[];
  recentErrors: string[];
  lastErrorAt?: string;
  tokenUsage?: TokenUsage[];
  logFiles: BotLogFiles;
  lastHeartbeat?: string;
  heartbeatStale?: boolean;
}

export interface SystemStatus {
  timestamp: string;
  podmanRunning: boolean;
  bots: BotStatus[];
}

// ── Helpers ────────────────────────────────────────────────────────

function safeExec(cmd: string, timeoutMs = 5000): string {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

function parseNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// ── Service status via launchctl ───────────────────────────────────

function getBotServiceStatus(bot: string): { service: 'running' | 'stopped'; pid?: number } {
  const label = `com.infiniclaw.${bot}`;
  const raw = safeExec(`launchctl list ${label} 2>/dev/null`);
  if (!raw) return { service: 'stopped' };

  // launchctl list <label> outputs key-value pairs; look for PID
  const pidMatch = raw.match(/"PID"\s*=\s*(\d+)/);
  if (pidMatch) {
    return { service: 'running', pid: parseInt(pidMatch[1], 10) };
  }

  // Fallback: try tabular output format "PID\tStatus\tLabel"
  const lines = raw.split('\n');
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 3 && parts[2] === label) {
      const pid = parseInt(parts[0], 10);
      if (!isNaN(pid) && pid > 0) {
        return { service: 'running', pid };
      }
    }
  }

  // If we got output at all, the service is loaded
  return { service: 'running' };
}

// ── Podman ─────────────────────────────────────────────────────────

function isPodmanRunning(): boolean {
  return safeExec('podman info 2>/dev/null') !== '';
}

interface PodmanContainer {
  Names?: string[] | string;
  State?: string;
  Status?: string;
  CreatedAt?: string;
  StartedAt?: string | number;
}

function getActiveContainers(): ContainerInfo[] {
  const raw = safeExec('podman ps --format json 2>/dev/null');
  if (!raw) return [];

  let containers: PodmanContainer[];
  try {
    containers = JSON.parse(raw);
  } catch {
    return [];
  }

  return containers
    .flatMap((c) => {
      const names = Array.isArray(c.Names) ? c.Names : c.Names ? [c.Names] : [];
      return names
        .filter((n: string) => n.startsWith('nanoclaw-'))
        .map((name: string) => {
          // Parse group from name: nanoclaw-{bot}-{group}-{ts}
          const parts = name.split('-');
          const group = parts.length >= 3 ? parts.slice(2, -1).join('-') : 'unknown';
          return {
            name,
            group,
            uptime: c.Status || 'unknown',
          };
        });
    });
}

// ── SQLite (read-only) ─────────────────────────────────────────────

function openReadonlyDb(instanceDir: string): Database.Database | null {
  const dbPath = path.join(instanceDir, 'store', 'messages.db');
  if (!fs.existsSync(dbPath)) return null;
  try {
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

function getDbGroups(db: Database.Database): GroupStatus[] {
  try {
    const rows = db.prepare(`
      SELECT rg.jid, rg.name, rg.folder, s.session_id
      FROM registered_groups rg
      LEFT JOIN sessions s ON rg.folder = s.group_folder
      ORDER BY rg.name
    `).all() as Array<{ jid: string; name: string; folder: string; session_id: string | null }>;

    return rows.map((r) => {
      const group: GroupStatus = {
        jid: r.jid,
        name: r.name,
        folder: r.folder,
        sessionId: r.session_id || undefined,
      };

      // Get chat activity from router_state
      const activityKey = `chat_activity:${encodeURIComponent(r.jid)}`;
      const activityRow = db.prepare('SELECT value FROM router_state WHERE key = ?').get(activityKey) as { value: string } | undefined;
      if (activityRow?.value) {
        try {
          const activity = JSON.parse(activityRow.value);
          group.currentObjective = activity.currentObjective;
          group.lastProgress = activity.lastProgress;
          if (typeof activity.lastProgressAt === 'number') {
            group.lastProgressAt = new Date(activity.lastProgressAt).toISOString();
          }
          group.lastError = activity.lastError;
          if (typeof activity.lastErrorAt === 'number') {
            group.lastErrorAt = new Date(activity.lastErrorAt).toISOString();
          }
        } catch {}
      }

      // Get last activity timestamp from messages
      const lastMsg = db.prepare(
        'SELECT timestamp FROM messages WHERE chat_jid = ? ORDER BY timestamp DESC LIMIT 1',
      ).get(r.jid) as { timestamp: string } | undefined;
      group.lastActivity = lastMsg?.timestamp;

      return group;
    });
  } catch {
    return [];
  }
}

function getDbTasks(db: Database.Database): TaskStatus[] {
  try {
    const rows = db.prepare(`
      SELECT id, prompt, schedule_type, schedule_value, status, next_run, last_run
      FROM scheduled_tasks
      ORDER BY created_at DESC
    `).all() as Array<{
      id: string;
      prompt: string;
      schedule_type: string;
      schedule_value: string;
      status: string;
      next_run: string | null;
      last_run: string | null;
    }>;

    return rows.map((r) => ({
      id: r.id,
      prompt: r.prompt.length > 80 ? r.prompt.slice(0, 77) + '...' : r.prompt,
      schedule: `${r.schedule_type}: ${r.schedule_value}`,
      status: r.status,
      nextRun: r.next_run || undefined,
      lastRun: r.last_run || undefined,
    }));
  } catch {
    return [];
  }
}

// ── Error logs ─────────────────────────────────────────────────────

function getRecentErrors(rootDir: string, bot: string, maxErrors = 10): { lines: string[]; lastErrorAt?: string } {
  // The .error.log is actually all pino output (stderr). Filter to only real errors.
  const logPath = path.join(rootDir, '_runtime', 'logs', `${bot}.error.log`);
  if (!fs.existsSync(logPath)) return { lines: [] };

  try {
    const content = fs.readFileSync(logPath, 'utf-8');
    const allLines = content.split('\n');
    // Only keep lines that contain ERROR or FATAL — the pino log level markers
    const errorLines = allLines.filter((l) => {
      const stripped = l.replace(/\x1B\[[0-9;]*m/g, '');
      return /\b(ERROR|FATAL)\b/.test(stripped);
    });
    const recent = errorLines.slice(-maxErrors);

    // Extract timestamp from the last error line: [HH:MM:SS.mmm] or ISO format
    let lastErrorAt: string | undefined;
    if (recent.length > 0) {
      const lastLine = recent[recent.length - 1].replace(/\x1B\[[0-9;]*m/g, '');
      // Pino-pretty format: [HH:MM:SS.mmm]
      const timeMatch = lastLine.match(/\[(\d{2}:\d{2}:\d{2}\.\d{3})\]/);
      if (timeMatch) {
        // Combine with today's date
        const today = new Date().toISOString().slice(0, 10);
        lastErrorAt = new Date(`${today}T${timeMatch[1]}Z`).toISOString();
      }
    }

    return { lines: recent, lastErrorAt };
  } catch {
    return { lines: [] };
  }
}

// ── Token usage from stats-cache ───────────────────────────────────

function getTokenUsage(instanceDir: string, mainGroupFolder: string): TokenUsage[] {
  const statsPath = path.join(instanceDir, 'data', 'sessions', mainGroupFolder, '.claude', 'stats-cache.json');
  if (!fs.existsSync(statsPath)) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
  } catch {
    return [];
  }

  if (!parsed || typeof parsed !== 'object') return [];

  const modelUsage = (parsed as { modelUsage?: unknown }).modelUsage;
  if (!modelUsage || typeof modelUsage !== 'object') return [];

  const result: TokenUsage[] = [];
  for (const [model, usage] of Object.entries(modelUsage)) {
    if (!model.trim() || !usage || typeof usage !== 'object') continue;
    const m = usage as Record<string, unknown>;
    const input = parseNumber(m.inputTokens);
    const output = parseNumber(m.outputTokens);
    const cacheRead = parseNumber(m.cacheReadInputTokens);
    if (input + output + cacheRead > 0) {
      result.push({
        model: model.trim(),
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
      });
    }
  }

  return result;
}

// ── Brain config from profile ──────────────────────────────────────

function getBrainConfig(rootDir: string, bot: string): { model?: string; provider?: string } {
  const envPath = path.join(rootDir, 'bots', 'profiles', bot, 'env');
  if (!fs.existsSync(envPath)) return {};

  const vars: Record<string, string> = {};
  try {
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      vars[key] = value;
    }
  } catch {
    return {};
  }

  const baseUrl = vars.BRAIN_BASE_URL || '';
  const isOllama = baseUrl.includes('ollama') || baseUrl.includes('11434');
  const provider = isOllama ? 'ollama' : 'claude';
  const model = vars.BRAIN_MODEL || vars.ANTHROPIC_MODEL || undefined;

  return { model, provider };
}

// ── Heartbeat ───────────────────────────────────────────────────────

const HEARTBEAT_STALE_MS = 3 * 60 * 1000; // 3 minutes

function getHeartbeat(instanceDir: string): { lastHeartbeat?: string; heartbeatStale?: boolean } {
  const heartbeatPath = path.join(instanceDir, 'data', 'heartbeat');
  if (!fs.existsSync(heartbeatPath)) return {};

  try {
    const raw = fs.readFileSync(heartbeatPath, 'utf-8').trim();
    const ts = parseInt(raw, 10);
    if (!ts || isNaN(ts)) return {};

    const lastHeartbeat = new Date(ts).toISOString();
    const stale = Date.now() - ts > HEARTBEAT_STALE_MS;
    return { lastHeartbeat, heartbeatStale: stale || undefined };
  } catch {
    return {};
  }
}

// ── Main entry ─────────────────────────────────────────────────────

export function getSystemStatus(rootDir: string): SystemStatus {
  const bots: BotStatus[] = [];
  const allContainers = getActiveContainers();

  for (const bot of ['engineer', 'commander']) {
    const { service, pid } = getBotServiceStatus(bot);
    const { model, provider } = getBrainConfig(rootDir, bot);
    const instanceDir = path.join(rootDir, '_runtime', 'instances', bot, 'nanoclaw');

    // Match containers by bot name prefix
    const botContainers = allContainers.filter((c) => {
      const parts = c.name.split('-');
      return parts.length >= 2 && parts[1] === bot.slice(0, 3);
    });

    // Special case: engineer bot tag is "cid", commander is "johnny5" or similar
    // The container name pattern is nanoclaw-{botTag}-{group}-{ts}
    // botTag comes from ASSISTANT_NAME lowercased stripped of non-alnum
    // We'll match by checking the instance dir's groups instead
    const botTag = bot === 'engineer' ? 'cid' : 'johnny5';
    const matchedContainers = allContainers.filter((c) => c.name.includes(`nanoclaw-${botTag}-`));

    const db = openReadonlyDb(instanceDir);
    const groups = db ? getDbGroups(db) : [];
    const tasks = db ? getDbTasks(db) : [];
    if (db) db.close();

    // Attach container log dir path to each group
    for (const g of groups) {
      const logDir = path.join(instanceDir, 'groups', g.folder, 'logs');
      if (fs.existsSync(logDir)) {
        g.containerLogDir = logDir;
      }
    }

    const { lines: recentErrors, lastErrorAt: logLastErrorAt } = getRecentErrors(rootDir, bot, 10);
    const tokenUsage = getTokenUsage(instanceDir, 'main');

    // Best lastErrorAt: prefer the more recent of log-parsed vs group chat_activity
    let bestLastErrorAt = logLastErrorAt;
    for (const g of groups) {
      if (g.lastErrorAt && (!bestLastErrorAt || g.lastErrorAt > bestLastErrorAt)) {
        bestLastErrorAt = g.lastErrorAt;
      }
    }

    const logFiles: BotLogFiles = {
      stdout: path.join(rootDir, '_runtime', 'logs', `${bot}.log`),
      stderr: path.join(rootDir, '_runtime', 'logs', `${bot}.error.log`),
      containerLogs: path.join(instanceDir, 'groups', 'main', 'logs'),
      db: path.join(instanceDir, 'store', 'messages.db'),
    };

    const heartbeat = getHeartbeat(instanceDir);

    bots.push({
      name: bot,
      service,
      pid,
      model,
      provider,
      containers: matchedContainers,
      groups,
      tasks,
      recentErrors,
      lastErrorAt: bestLastErrorAt,
      tokenUsage: tokenUsage.length > 0 ? tokenUsage : undefined,
      logFiles,
      lastHeartbeat: heartbeat.lastHeartbeat,
      heartbeatStale: heartbeat.heartbeatStale,
    });
  }

  return {
    timestamp: new Date().toISOString(),
    podmanRunning: isPodmanRunning(),
    bots,
  };
}

/**
 * Get recent log lines from a bot's error or stdout log.
 */
export function getRecentLogLines(rootDir: string, bot: string, logType: 'error' | 'stdout' = 'error', lines = 50): string[] {
  const ext = logType === 'error' ? 'error.log' : 'log';
  const logPath = path.join(rootDir, '_runtime', 'logs', `${bot}.${ext}`);
  if (!fs.existsSync(logPath)) return [];

  try {
    const content = fs.readFileSync(logPath, 'utf-8');
    const allLines = content.split('\n').filter((l) => l.trim());
    return allLines.slice(-lines);
  } catch {
    return [];
  }
}

/**
 * Get current activity summary for each bot — what they're working on right now.
 */
export function getBotActivity(rootDir: string): Array<{ bot: string; activity: string }> {
  const result: Array<{ bot: string; activity: string }> = [];

  for (const bot of ['engineer', 'commander']) {
    const instanceDir = path.join(rootDir, '_runtime', 'instances', bot, 'nanoclaw');
    const db = openReadonlyDb(instanceDir);
    if (!db) {
      result.push({ bot, activity: 'no database' });
      continue;
    }

    const lines: string[] = [];
    try {
      // Get all registered groups
      const groups = db.prepare('SELECT jid, name, folder FROM registered_groups').all() as Array<{ jid: string; name: string; folder: string }>;

      for (const group of groups) {
        const activityKey = `chat_activity:${encodeURIComponent(group.jid)}`;
        const row = db.prepare('SELECT value FROM router_state WHERE key = ?').get(activityKey) as { value: string } | undefined;
        if (!row?.value) continue;

        try {
          const activity = JSON.parse(row.value);
          const parts: string[] = [`[${group.name}]`];
          if (activity.runStartedAt) {
            const elapsed = Math.round((Date.now() - activity.runStartedAt) / 1000);
            parts.push(`active (${elapsed}s)`);
          } else {
            parts.push('idle');
          }
          if (activity.currentObjective) parts.push(`objective: ${activity.currentObjective}`);
          if (activity.lastProgress) {
            const ago = activity.lastProgressAt ? `${Math.round((Date.now() - activity.lastProgressAt) / 1000)}s ago` : '';
            parts.push(`progress: ${activity.lastProgress}${ago ? ` (${ago})` : ''}`);
          }
          if (activity.lastError) parts.push(`error: ${activity.lastError}`);
          lines.push(parts.join(' — '));
        } catch {}
      }
    } catch {}

    db.close();
    result.push({ bot, activity: lines.length > 0 ? lines.join('\n') : 'idle' });
  }

  return result;
}
