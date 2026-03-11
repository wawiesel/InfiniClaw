/**
 * InfiniClaw brain management.
 * Model resolution, quota fallback, Ollama detection, auto-switch.
 */
import fs from 'fs';
import path from 'path';

import { isOllamaBaseUrl, parseEnvLine, upsertEnvLine } from './env-utils.js';
import { loadShipConfig, isValidBotName } from './ship-config.js';
import { ASSISTANT_NAME, DATA_DIR } from 'nanoclaw/config.js';
import { MAIN_GROUP_FOLDER } from './infini-config.js';
import { logger } from 'nanoclaw/logger.js';
import { capitalizeName, escapeHtml } from './formatting.js';

const PROJECT_ENV_PATH = path.join(process.cwd(), '.env');
const MAIN_MODEL_ENV_KEY = 'ANTHROPIC_MODEL';
const AUTO_BRAIN_SWITCH_COOLDOWN_MS = 10 * 60 * 1000;
const MAX_MODEL_NAME_LENGTH = 200;

let lastAutoBrainSwitchAt = 0;

function loadProjectEnv(): Record<string, string> {
  const values: Record<string, string> = {};
  if (!fs.existsSync(PROJECT_ENV_PATH)) return values;

  try {
    const envContent = fs.readFileSync(PROJECT_ENV_PATH, 'utf-8');
    for (const line of envContent.split('\n')) {
      const parsed = parseEnvLine(line);
      if (!parsed) continue;
      const [key, value] = parsed;
      values[key] = value;
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to read project .env');
  }

  return values;
}

const PROJECT_ENV = loadProjectEnv();

function getConfiguredEnv(key: string): string | undefined {
  const s = process.env[key]?.trim();
  if (s) return s;
  const p = PROJECT_ENV[key]?.trim();
  return p || undefined;
}

function isPathWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sanitizeModelName(model: string | undefined): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_MODEL_NAME_LENGTH) return undefined;
  if (/[\x00-\x1F\x7F]/.test(trimmed)) return undefined;
  if (/[<>]/.test(trimmed)) return undefined;
  return trimmed;
}

export function resolveConfiguredMainModel(): string | undefined {
  return sanitizeModelName(getConfiguredEnv(MAIN_MODEL_ENV_KEY));
}

function parseNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Find the model key with the highest numeric score from a { model: score|object } map. */
function bestModelByScore(
  entries: Record<string, unknown>,
  scorer: (value: unknown) => number,
): string | undefined {
  let best: string | undefined;
  let bestScore = -1;
  for (const [model, value] of Object.entries(entries)) {
    if (!model.trim()) continue;
    const score = scorer(value);
    if (score > bestScore) {
      bestScore = score;
      best = model.trim();
    }
  }
  return best;
}

function getClaudeModelFromStatsCache(): string | undefined {
  const statsPath = path.join(
    DATA_DIR,
    'sessions',
    MAIN_GROUP_FOLDER,
    '.claude',
    'stats-cache.json',
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
  } catch {
    return undefined;
  }

  if (!parsed || typeof parsed !== 'object') return undefined;

  // Prefer modelUsage since it summarizes overall token usage by model.
  const modelUsage = (parsed as { modelUsage?: unknown }).modelUsage;
  if (modelUsage && typeof modelUsage === 'object') {
    const result = bestModelByScore(modelUsage as Record<string, unknown>, (usage) => {
      if (!usage || typeof usage !== 'object') return 0;
      const m = usage as Record<string, unknown>;
      return parseNumber(m.inputTokens) + parseNumber(m.outputTokens)
        + parseNumber(m.cacheReadInputTokens) + parseNumber(m.cacheCreationInputTokens);
    });
    if (result) return result;
  }

  // Fallback: inspect most recent daily tokens by model.
  const dailyModelTokens = (parsed as { dailyModelTokens?: unknown }).dailyModelTokens;
  if (Array.isArray(dailyModelTokens)) {
    for (let i = dailyModelTokens.length - 1; i >= 0; i -= 1) {
      const dayEntry = dailyModelTokens[i];
      if (!dayEntry || typeof dayEntry !== 'object') continue;
      const tokensByModel = (dayEntry as { tokensByModel?: unknown }).tokensByModel;
      if (!tokensByModel || typeof tokensByModel !== 'object') continue;
      const result = bestModelByScore(tokensByModel as Record<string, unknown>, (v) => parseNumber(v));
      if (result) return result;
    }
  }

  return undefined;
}

export function resolveMainProvider(): 'claude' | 'ollama' {
  return isOllamaBaseUrl(getConfiguredEnv('ANTHROPIC_BASE_URL')) ? 'ollama' : 'claude';
}

function isGenericClaudeModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  if (!normalized || normalized === 'default') return true;

  // Family aliases like "opus", "claude-sonnet", "claude-opus-latest" are generic.
  // Any model string containing digits is considered specific (e.g. claude-opus-4-6).
  return /^(claude-)?(opus|sonnet|haiku)(-[a-z._-]+)?$/.test(normalized) && !/\d/.test(normalized);
}

export function normalizeMainLlm(model: string | undefined): string | undefined {
  const trimmed = sanitizeModelName(model);
  if (!trimmed) return undefined;

  if (resolveMainProvider() !== 'claude') {
    return trimmed;
  }

  if (!isGenericClaudeModel(trimmed)) {
    return trimmed;
  }

  // Try to upgrade generic aliases to a concrete dated model if available.
  const fromStats = sanitizeModelName(getClaudeModelFromStatsCache());
  if (fromStats && !isGenericClaudeModel(fromStats)) {
    return fromStats;
  }

  return undefined;
}

function applyOllamaFallbackToProfile(envFile: string): void {
  upsertEnvLine(envFile, 'BRAIN_MODEL', 'devstral-small-2-fast:latest');
  upsertEnvLine(
    envFile,
    'BRAIN_BASE_URL',
    'http://host.containers.internal:11434',
  );
  upsertEnvLine(envFile, 'BRAIN_AUTH_TOKEN', 'ollama');
  upsertEnvLine(envFile, 'BRAIN_API_KEY', '');
  upsertEnvLine(envFile, 'BRAIN_OAUTH_TOKEN', '');
}

function isAnthropicQuotaError(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('insufficient_quota') ||
    lower.includes('insufficient quota') ||
    lower.includes('credit balance') ||
    lower.includes('credits') ||
    (lower.includes('anthropic') && lower.includes('rate limit'))
  );
}

export async function maybeAutoSwitchBrainsOnQuotaError(
  rawError: string,
  chatJid: string,
  sendMessage: (jid: string, text: string) => Promise<void>,
): Promise<void> {
  if (!isAnthropicQuotaError(rawError)) return;
  if (Date.now() - lastAutoBrainSwitchAt < AUTO_BRAIN_SWITCH_COOLDOWN_MS) return;
  lastAutoBrainSwitchAt = Date.now();

  let config;
  try { config = loadShipConfig(); } catch { return; }

  let secretsRoot: string;
  try {
    secretsRoot = fs.realpathSync(config.secretsPath);
  } catch {
    return;
  }

  const switched: string[] = [];
  for (const rawBot of config.bots) {
    const trimmed = rawBot.trim();
    const bot = trimmed && isValidBotName(trimmed) ? trimmed : undefined;
    if (!bot) {
      logger.warn({ bot: rawBot }, 'Skipping invalid bot name in machine config');
      continue;
    }

    const envPath = path.resolve(secretsRoot, bot, 'env');
    if (!isPathWithinRoot(secretsRoot, envPath)) {
      logger.warn({ bot, envPath }, 'Skipping bot with env path outside secrets root');
      continue;
    }
    if (!fs.existsSync(envPath)) continue;

    let safeEnvPath: string;
    try {
      safeEnvPath = fs.realpathSync(envPath);
    } catch {
      continue;
    }
    if (!isPathWithinRoot(secretsRoot, safeEnvPath)) {
      logger.warn({ bot, safeEnvPath }, 'Skipping bot with symlinked env path outside secrets root');
      continue;
    }

    try {
      applyOllamaFallbackToProfile(safeEnvPath);
      switched.push(bot);
    } catch (err) {
      logger.error({ err, bot }, 'Failed ollama fallback switch for bot');
    }
  }

  if (switched.length === 0) return;

  try {
    await sendMessage(
      chatJid,
      `Anthropic credits/quotas look exhausted. Switched ${switched.join(', ')} to ollama fallback. Restart bots to apply.`,
    );
    logger.warn({ switched }, 'Auto-switched bot brain profiles to ollama fallback due to quota error');
  } catch (err) {
    logger.error({ err }, 'Failed to send ollama fallback notification');
  }
}

export function resolveMainLlm(): string {
  const configuredModel = normalizeMainLlm(resolveConfiguredMainModel());
  if (configuredModel) return configuredModel;

  if (resolveMainProvider() === 'claude') {
    const statsModel = normalizeMainLlm(getClaudeModelFromStatsCache());
    if (statsModel) return statsModel;
    return 'unknown-model';
  }

  return 'unknown-model';
}

// Module-level state
export const MAIN_PROVIDER = resolveMainProvider();
export let mainLlm = resolveMainLlm();

export function setMainLlm(model: string): void {
  mainLlm = sanitizeModelName(model) ?? 'unknown-model';
}

export function mainSender(): string {
  const providerName = capitalizeName(MAIN_PROVIDER);
  const modelName = sanitizeModelName(mainLlm) || 'unknown-model';
  return `<font color="#888888">🧠 <em>${providerName}/${escapeHtml(modelName)}</em></font>`;
}

export function defaultSenderForGroup(
  sourceGroup: string,
  registeredGroups: Record<string, { folder: string; name: string }>,
): string {
  if (sourceGroup === MAIN_GROUP_FOLDER) {
    return mainSender();
  }

  const groupName = Object.values(registeredGroups).find(
    (g) => g.folder === sourceGroup,
  )?.name;
  return groupName?.trim() || sourceGroup;
}
