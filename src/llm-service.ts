import fs from 'fs';
import path from 'path';
import { logger } from 'nanoclaw/logger.js';
import { DATA_DIR, ASSISTANT_NAME } from 'nanoclaw/config.js';
import { MAIN_GROUP_FOLDER } from './infini-config.js';
import { isOllamaBaseUrl, parseEnvLine, upsertEnvLine } from 'nanoclaw/env-utils.js';
import { loadShipConfig } from './ship-config.js';

const METRICS_HISTORY_FILE = path.join(DATA_DIR, 'metrics-history.jsonl');
const METRICS_HISTORY_MAX_LINES = 10_000;
const PROJECT_ENV_PATH = path.join(process.cwd(), '.env');
const MAIN_MODEL_ENV_KEY = 'ANTHROPIC_MODEL';
const AUTO_BRAIN_SWITCH_COOLDOWN_MS = 10 * 60 * 1000;
const MAX_MODEL_NAME_LENGTH = 200;

let lastAutoBrainSwitchAt = 0;

export function recordMetrics(stats: any): void {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...stats }) + '\n';
    fs.appendFileSync(METRICS_HISTORY_FILE, line);
    const content = fs.readFileSync(METRICS_HISTORY_FILE, 'utf-8').split('\n').filter(Boolean);
    if (content.length > METRICS_HISTORY_MAX_LINES) {
      fs.writeFileSync(METRICS_HISTORY_FILE, content.slice(-METRICS_HISTORY_MAX_LINES).join('\n') + '\n');
    }
  } catch (err) { logger.debug({ err }, 'Failed to record metrics'); }
}

function loadProjectEnv(): Record<string, string> {
  const values: Record<string, string> = {};
  if (!fs.existsSync(PROJECT_ENV_PATH)) return values;
  try {
    const envContent = fs.readFileSync(PROJECT_ENV_PATH, 'utf-8');
    for (const line of envContent.split('\n')) {
      const parsed = parseEnvLine(line);
      if (parsed) values[parsed[0]] = parsed[1];
    }
  } catch { }
  return values;
}

const PROJECT_ENV = loadProjectEnv();

function getConfiguredEnv(key: string): string | undefined {
  return process.env[key] || PROJECT_ENV[key];
}

function sanitizeModelName(model: string | undefined): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed || trimmed.length > MAX_MODEL_NAME_LENGTH || /[\x00-\x1F\x7F]/.test(trimmed) || /[<>]/.test(trimmed)) return undefined;
  return trimmed;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function resolveConfiguredMainModel(): string | undefined {
  return sanitizeModelName(getConfiguredEnv(MAIN_MODEL_ENV_KEY));
}

function getClaudeModelFromStatsCache(): string | undefined {
  const statsPath = path.join(DATA_DIR, 'sessions', MAIN_GROUP_FOLDER, '.claude', 'stats-cache.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
    const modelUsage = parsed?.modelUsage;
    if (modelUsage && typeof modelUsage === 'object') {
      let best: string | undefined;
      let max = -1;
      for (const [m, u] of Object.entries(modelUsage as any)) {
        const score = (u as any).inputTokens + (u as any).outputTokens;
        if (score > max) { max = score; best = m; }
      }
      if (best) return best;
    }
  } catch { }
  return undefined;
}

export function resolveMainProvider(): 'claude' | 'ollama' {
  return isOllamaBaseUrl(getConfiguredEnv('ANTHROPIC_BASE_URL')) ? 'ollama' : 'claude';
}

export function normalizeMainLlm(model: string | undefined): string | undefined {
  const trimmed = sanitizeModelName(model);
  if (!trimmed || resolveMainProvider() !== 'claude') return trimmed;
  if (/^(claude-)?(opus|sonnet|haiku)(-[a-z._-]+)?$/.test(trimmed.toLowerCase()) && !/\d/.test(trimmed)) {
    const fromStats = getClaudeModelFromStatsCache()?.trim();
    if (fromStats && !isGenericClaudeModel(fromStats)) return fromStats;
  }
  return trimmed;
}

function isGenericClaudeModel(model: string): boolean {
  const n = model.toLowerCase();
  return /^(claude-)?(opus|sonnet|haiku)(-[a-z._-]+)?$/.test(n) && !/\d/.test(n);
}

export const MAIN_PROVIDER = resolveMainProvider();
export let mainLlm = normalizeMainLlm(resolveConfiguredMainModel()) || getClaudeModelFromStatsCache() || 'unknown-model';

export function setMainLlm(model: string): void {
  mainLlm = model;
}

export function mainSender(): string {
  const provider = MAIN_PROVIDER.charAt(0).toUpperCase() + MAIN_PROVIDER.slice(1);
  return `<font color="#888888">🧠 <em>${provider}/${escapeHtml(mainLlm)}</em></font>`;
}

export function defaultSenderForGroup(sourceGroup: string, registeredGroups: Record<string, { folder: string; name: string }>): string {
  if (sourceGroup === MAIN_GROUP_FOLDER) return mainSender();
  const group = Object.values(registeredGroups).find(g => g.folder === sourceGroup);
  return group?.name.trim() || sourceGroup;
}

export async function maybeAutoSwitchBrainsOnQuotaError(rawError: string, chatJid: string, sendMessage: (jid: string, text: string) => Promise<void>): Promise<void> {
  const lower = rawError.toLowerCase();
  if (!lower.includes('quota') && !lower.includes('credit') && !lower.includes('rate limit')) return;
  if (Date.now() - lastAutoBrainSwitchAt < AUTO_BRAIN_SWITCH_COOLDOWN_MS) return;

  try {
    const config = loadShipConfig();
    const switched: string[] = [];
    for (const bot of config.bots) {
      const envFile = path.join(config.secretsPath, 'bots', bot, 'env');
      if (fs.existsSync(envFile)) {
        upsertEnvLine(envFile, 'BRAIN_MODEL', 'devstral-small-2-fast:latest');
        upsertEnvLine(envFile, 'BRAIN_BASE_URL', 'http://host.containers.internal:11434');
        upsertEnvLine(envFile, 'BRAIN_AUTH_TOKEN', 'ollama');
        upsertEnvLine(envFile, 'BRAIN_API_KEY', '');
        upsertEnvLine(envFile, 'BRAIN_OAUTH_TOKEN', '');
        switched.push(bot);
      }
    }
    if (switched.length > 0) {
      lastAutoBrainSwitchAt = Date.now();
      await sendMessage(chatJid, `Anthropic quota exhausted. Switched ${switched.join(', ')} to ollama fallback. Restart bots to apply.`);
    }
  } catch { }
}
