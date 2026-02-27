/**
 * InfiniClaw brain management.
 * Model resolution, quota fallback, Ollama detection, auto-switch.
 */
import fs from 'fs';
import path from 'path';

import { isOllamaBaseUrl, parseEnvLine, upsertEnvLine } from 'nanoclaw/env-utils.js';
import { loadMachineConfig } from './machine-config.js';
import {
  ASSISTANT_NAME,
  DATA_DIR,
  MAIN_GROUP_FOLDER,
} from 'nanoclaw/config.js';
import { logger } from 'nanoclaw/logger.js';

const PROJECT_ENV_PATH = path.join(process.cwd(), '.env');
const MAIN_MODEL_ENV_KEY = 'ANTHROPIC_MODEL';
const AUTO_BRAIN_SWITCH_COOLDOWN_MS = 10 * 60 * 1000;

let lastAutoBrainSwitchAt = 0;

function firstSet(...values: Array<string | undefined>): string | undefined {
  for (const v of values) {
    const s = v?.trim();
    if (s) return s;
  }
  return undefined;
}

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
  return firstSet(process.env[key], PROJECT_ENV[key]);
}

function isMainConfiguredForOllama(): boolean {
  return isOllamaBaseUrl(getConfiguredEnv('ANTHROPIC_BASE_URL'));
}

export function resolveConfiguredMainModel(): string | undefined {
  return getConfiguredEnv(MAIN_MODEL_ENV_KEY)?.trim() || undefined;
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
  if (isMainConfiguredForOllama()) {
    return 'ollama';
  }
  return 'claude';
}

function isGenericClaudeModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  if (!normalized || normalized === 'default') return true;

  // Family aliases like "opus", "claude-sonnet", "claude-opus-latest" are generic.
  // Any model string containing digits is considered specific (e.g. claude-opus-4-6).
  return /^(claude-)?(opus|sonnet|haiku)(-[a-z._-]+)?$/.test(normalized) && !/\d/.test(normalized);
}

export function normalizeMainLlm(model: string | undefined): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;

  if (resolveMainProvider() !== 'claude') {
    return trimmed;
  }

  if (!isGenericClaudeModel(trimmed)) {
    return trimmed;
  }

  // Try to upgrade generic aliases to a concrete dated model if available.
  const fromStats = getClaudeModelFromStatsCache()?.trim();
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
  if (!['engineer'].includes(ASSISTANT_NAME.trim().toLowerCase())) return;
  if (!isAnthropicQuotaError(rawError)) return;
  if (Date.now() - lastAutoBrainSwitchAt < AUTO_BRAIN_SWITCH_COOLDOWN_MS) return;

  let config;
  try { config = loadMachineConfig(); } catch { return; }
  const engineerEnv = path.join(config.secretsPath, 'engineer', 'env');
  const commanderEnv = path.join(config.secretsPath, 'commander', 'env');
  if (!fs.existsSync(engineerEnv) || !fs.existsSync(commanderEnv)) return;

  try {
    applyOllamaFallbackToProfile(engineerEnv);
    applyOllamaFallbackToProfile(commanderEnv);
    lastAutoBrainSwitchAt = Date.now();
    await sendMessage(
      chatJid,
      'Anthropic credits/quotas look exhausted. I switched engineer and commander brain profiles to ollama fallback. Restart both bots to apply.',
    );
    logger.warn('Auto-switched bot brain profiles to ollama fallback due to quota error');
  } catch (err) {
    logger.error({ err }, 'Failed automatic ollama fallback switch');
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
  mainLlm = model;
}

export function mainSender(): string {
  const providerName = MAIN_PROVIDER.charAt(0).toUpperCase() + MAIN_PROVIDER.slice(1);
  return `<font color="#888888">🧠 <em>${providerName}/${mainLlm}</em></font>`;
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
