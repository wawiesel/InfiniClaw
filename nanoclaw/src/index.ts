import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  ASSISTANT_REACTION,
  ASSISTANT_ROLE,
  ASSISTANT_TRIGGER,
  CONTAINER_IMAGE,
  DATA_DIR,
  GROUPS_DIR,
  HEAP_LIMIT_MB,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  MATRIX_ACCESS_TOKEN,
  MATRIX_HOMESERVER,
  MATRIX_PASSWORD,
  MATRIX_RECONNECT_INTERVAL,
  MATRIX_USERNAME,
  CROSS_BOT_PATTERN,
  CROSS_BOT_ROOM_JID,
  LOCAL_CHANNEL_ENABLED,
  LOCAL_CHAT_JID,
  LOCAL_MIRROR_MATRIX_JID,
  MEMORY_CHECK_INTERVAL,
  POLL_INTERVAL,
  TRIGGER_PATTERN,
  IGNORE_PATTERNS,
  IGNORE_SENDERS,
} from './config.js';
import { MatrixChannel } from './channels/matrix.js';
import { LocalCliChannel } from './channels/local-cli.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  deleteSession,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { startIpcWatcher } from './ipc.js';
import { readBrainMode } from './ipc.js';
import { findChannel, formatMessages, stripInternalTags } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;
const QUEUED_ACK_COOLDOWN_MS = 30_000;
const lastQueuedAckAt: Record<string, number> = {};
const ACTIVE_PIPE_ACK_COOLDOWN_MS = 5_000;
const lastActivePipeAckAt: Record<string, number> = {};
const PROGRESS_CHAT_COOLDOWN_MS = 10_000;
const lastProgressChatAt: Record<string, number> = {};
const RUN_PROGRESS_NUDGE_STALE_MS = 90_000;
const RUN_PROGRESS_NUDGE_COOLDOWN_MS = 120_000;
const RUN_PROGRESS_NUDGE_CHECK_MS = 15_000;
const AUTO_BRAIN_SWITCH_COOLDOWN_MS = 10 * 60 * 1000;
const PROJECT_ENV_PATH = path.join(process.cwd(), '.env');
const MAIN_MODEL_ENV_KEY = 'ANTHROPIC_MODEL';
let lastAutoBrainSwitchAt = 0;

interface ChatActivity {
  runStartedAt?: number;
  currentObjective?: string;
  currentObjectiveAt?: number;
  recentUserContext?: string[];
  lastProgress?: string;
  lastProgressAt?: number;
  lastCompletion?: string;
  lastCompletionAt?: number;
  lastError?: string;
  lastErrorAt?: number;
}

const chatActivity: Record<string, ChatActivity> = {};
const CHAT_ACTIVITY_STATE_PREFIX = 'chat_activity:';

function firstSet(...values: Array<string | undefined>): string | undefined {
  for (const v of values) {
    const s = v?.trim();
    if (s) return s;
  }
  return undefined;
}

function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match) return null;
  const key = match[1];
  let value = match[2];
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return [key, value];
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

function isOllamaAnthropicBaseUrl(baseUrl: string | undefined): boolean {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return false;

  const normalized = trimmed.toLowerCase();
  if (normalized.includes('ollama')) return true;

  try {
    const parsed = new URL(trimmed);
    const port =
      parsed.port ||
      (parsed.protocol === 'https:' ? '443' : parsed.protocol === 'http:' ? '80' : '');
    return port === '11434';
  } catch {
    return false;
  }
}

function isMainConfiguredForOllama(): boolean {
  return isOllamaAnthropicBaseUrl(getConfiguredEnv('ANTHROPIC_BASE_URL'));
}

function resolveConfiguredMainModel(): string | undefined {
  return getConfiguredEnv(MAIN_MODEL_ENV_KEY)?.trim() || undefined;
}

function parseNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
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
    let bestModel: string | undefined;
    let bestScore = -1;
    for (const [model, usage] of Object.entries(modelUsage)) {
      if (!model.trim() || !usage || typeof usage !== 'object') continue;
      const metrics = usage as Record<string, unknown>;
      const score =
        parseNumber(metrics.inputTokens) +
        parseNumber(metrics.outputTokens) +
        parseNumber(metrics.cacheReadInputTokens) +
        parseNumber(metrics.cacheCreationInputTokens);
      if (score > bestScore) {
        bestScore = score;
        bestModel = model.trim();
      }
    }
    if (bestModel) return bestModel;
  }

  // Fallback: inspect most recent daily tokens by model.
  const dailyModelTokens = (parsed as { dailyModelTokens?: unknown }).dailyModelTokens;
  if (Array.isArray(dailyModelTokens)) {
    for (let i = dailyModelTokens.length - 1; i >= 0; i -= 1) {
      const dayEntry = dailyModelTokens[i];
      if (!dayEntry || typeof dayEntry !== 'object') continue;
      const tokensByModel = (dayEntry as { tokensByModel?: unknown }).tokensByModel;
      if (!tokensByModel || typeof tokensByModel !== 'object') continue;

      let bestModel: string | undefined;
      let bestTokens = -1;
      for (const [model, tokens] of Object.entries(tokensByModel)) {
        const tokenCount = parseNumber(tokens);
        if (model.trim() && tokenCount > bestTokens) {
          bestTokens = tokenCount;
          bestModel = model.trim();
        }
      }
      if (bestModel) return bestModel;
    }
  }

  return undefined;
}

function resolveMainProvider(): 'claude' | 'ollama' {
  if (isMainConfiguredForOllama()) {
    return 'ollama';
  }
  return 'claude';
}

function isGenericClaudeModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return true;

  if (
    normalized === 'default' ||
    normalized === 'opus' ||
    normalized === 'sonnet' ||
    normalized === 'haiku' ||
    normalized === 'claude-opus' ||
    normalized === 'claude-sonnet' ||
    normalized === 'claude-haiku'
  ) {
    return true;
  }

  // Treat family aliases like claude-opus, claude-opus-latest as non-specific.
  // Any model string containing digits is considered specific (e.g. claude-opus-4-6).
  if (/^(claude-)?(opus|sonnet|haiku)(-[a-z._-]+)?$/i.test(normalized) && !/\d/.test(normalized)) {
    return true;
  }

  return false;
}

function normalizeMainLlm(model: string | undefined): string | undefined {
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

function upsertEnvLine(envFile: string, key: string, value: string): void {
  const lines = fs.existsSync(envFile)
    ? fs.readFileSync(envFile, 'utf-8').split('\n')
    : [];
  const next = `${key}=${value}`;
  let replaced = false;
  const updated = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      replaced = true;
      return next;
    }
    return line;
  });
  if (!replaced) updated.push(next);
  fs.writeFileSync(envFile, `${updated.join('\n').replace(/\n*$/, '\n')}`);
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

async function maybeAutoSwitchBrainsOnQuotaError(
  rawError: string,
  chatJid: string,
): Promise<void> {
  if (!['engineer'].includes(ASSISTANT_NAME.trim().toLowerCase())) return;
  if (!isAnthropicQuotaError(rawError)) return;
  if (Date.now() - lastAutoBrainSwitchAt < AUTO_BRAIN_SWITCH_COOLDOWN_MS) return;

  const root = process.env.INFINICLAW_ROOT?.trim() || path.resolve(process.cwd(), '..', '..', '..');
  const engineerEnv = path.join(root, 'bots', 'profiles', 'engineer', 'env');
  const commanderEnv = path.join(root, 'bots', 'profiles', 'commander', 'env');
  if (!fs.existsSync(engineerEnv) || !fs.existsSync(commanderEnv)) return;

  try {
    applyOllamaFallbackToProfile(engineerEnv);
    applyOllamaFallbackToProfile(commanderEnv);
    lastAutoBrainSwitchAt = Date.now();
    const ch = findChannel(channels, chatJid);
    if (ch) {
      await ch.sendMessage(
        chatJid,
        formatMainMessage(
          'Anthropic credits/quotas look exhausted. I switched engineer and commander brain profiles to ollama fallback. Restart both bots to apply.',
        ),
      );
    }
    logger.warn('Auto-switched bot brain profiles to ollama fallback due to quota error');
  } catch (err) {
    logger.error({ err }, 'Failed automatic ollama fallback switch');
  }
}
function resolveMainLlm(): string {
  const configuredModel = normalizeMainLlm(resolveConfiguredMainModel());
  if (configuredModel) return configuredModel;

  if (resolveMainProvider() === 'claude') {
    const statsModel = normalizeMainLlm(getClaudeModelFromStatsCache());
    if (statsModel) return statsModel;
    return 'unknown-model';
  }

  return 'unknown-model';
}
const MAIN_PROVIDER = resolveMainProvider();
let mainLlm = resolveMainLlm();

function updateMainLlm(model?: string): void {
  const normalized = normalizeMainLlm(model);
  if (!normalized || normalized === mainLlm) return;
  mainLlm = normalized;
  setRouterState('main_model', mainLlm);
  logger.info({ mainModel: mainLlm }, 'Updated MAIN model label');
}

function mainSender(): string {
  const providerName = MAIN_PROVIDER.charAt(0).toUpperCase() + MAIN_PROVIDER.slice(1);
  const role = ASSISTANT_ROLE;
  return `<font color="#888888">🧠 ${role} <em>(${providerName}/${mainLlm})</em></font>`;
}

function defaultSenderForGroup(sourceGroup: string): string {
  if (sourceGroup === MAIN_GROUP_FOLDER) {
    return mainSender();
  }

  const groupName = Object.values(registeredGroups).find(
    (g) => g.folder === sourceGroup,
  )?.name;
  return groupName?.trim() || sourceGroup;
}

function deriveFolderFromChatJid(chatJid: string): string {
  const base = chatJid
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const short = base.slice(0, 48) || 'chat';
  return `chat-${short}`;
}

function ensureGroupForIncomingChat(
  chatJid: string,
  chatName?: string,
): void {
  // Never auto-register the cross-bot room — we only send there, never listen
  if (CROSS_BOT_ROOM_JID && chatJid === CROSS_BOT_ROOM_JID) return;

  if (registeredGroups[chatJid]) {
    if (
      LOCAL_CHANNEL_ENABLED &&
      chatJid === LOCAL_CHAT_JID &&
      registeredGroups[chatJid].requiresTrigger !== false
    ) {
      const updated: RegisteredGroup = {
        ...registeredGroups[chatJid],
        requiresTrigger: false,
      };
      registerGroup(chatJid, updated);
      logger.info(
        { chatJid },
        'Terminal local-chat group set to direct mode (requiresTrigger=false)',
      );
    }
    return;
  }

  const hasMain = Object.values(registeredGroups).some(
    (g) => g.folder === MAIN_GROUP_FOLDER,
  );

  const name = (chatName || chatJid).trim() || chatJid;
  const addedAt = new Date().toISOString();
  const defaultTrigger = `@${ASSISTANT_TRIGGER}`;
  const localDirectMode = LOCAL_CHANNEL_ENABLED && chatJid === LOCAL_CHAT_JID;
  const group: RegisteredGroup = hasMain
    ? {
        name,
        folder: deriveFolderFromChatJid(chatJid),
        trigger: defaultTrigger,
        added_at: addedAt,
        requiresTrigger: false,
      }
    : {
        name,
        folder: MAIN_GROUP_FOLDER,
        trigger: defaultTrigger,
        added_at: addedAt,
        requiresTrigger: false,
      };

  registerGroup(chatJid, group);
  logger.info(
    { chatJid, folder: group.folder, requiresTrigger: group.requiresTrigger },
    'Auto-registered group for incoming chat',
  );
}

function getMainChatJid(): string | undefined {
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (group.folder === MAIN_GROUP_FOLDER) return jid;
  }
  return undefined;
}

function formatMainMessage(body: string): string {
  return body.trim();
}

function chatActivityStateKey(chatJid: string): string {
  return `${CHAT_ACTIVITY_STATE_PREFIX}${encodeURIComponent(chatJid)}`;
}

function sanitizeActivity(raw: unknown): ChatActivity {
  if (!raw || typeof raw !== 'object') return {};
  const record = raw as Record<string, unknown>;
  const out: ChatActivity = {};
  if (typeof record.runStartedAt === 'number') out.runStartedAt = record.runStartedAt;
  if (typeof record.currentObjective === 'string') out.currentObjective = record.currentObjective;
  if (typeof record.currentObjectiveAt === 'number') out.currentObjectiveAt = record.currentObjectiveAt;
  if (typeof record.lastProgress === 'string') out.lastProgress = record.lastProgress;
  if (typeof record.lastProgressAt === 'number') out.lastProgressAt = record.lastProgressAt;
  if (typeof record.lastCompletion === 'string') out.lastCompletion = record.lastCompletion;
  if (typeof record.lastCompletionAt === 'number') out.lastCompletionAt = record.lastCompletionAt;
  if (typeof record.lastError === 'string') out.lastError = record.lastError;
  if (typeof record.lastErrorAt === 'number') out.lastErrorAt = record.lastErrorAt;
  if (Array.isArray(record.recentUserContext)) {
    out.recentUserContext = record.recentUserContext
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .map((v) => v.trim())
      .slice(-6);
  }
  return out;
}

function persistChatActivity(chatJid: string): void {
  const activity = chatActivity[chatJid];
  if (!activity) return;
  try {
    setRouterState(chatActivityStateKey(chatJid), JSON.stringify(activity));
  } catch (err) {
    logger.warn({ err, chatJid }, 'Failed to persist chat activity');
  }
}

function ensureChatActivity(chatJid: string): ChatActivity {
  if (!chatActivity[chatJid]) {
    const persisted = getRouterState(chatActivityStateKey(chatJid));
    if (persisted) {
      try {
        chatActivity[chatJid] = sanitizeActivity(JSON.parse(persisted));
      } catch {
        chatActivity[chatJid] = {};
      }
    } else {
      chatActivity[chatJid] = {};
    }
  }
  return chatActivity[chatJid];
}

/** Returns true if the message is addressed to another bot and should be ignored. */
function isIgnoredTrigger(text: string): boolean {
  if (IGNORE_PATTERNS.length === 0) return false;
  const trimmed = text.trim();
  return IGNORE_PATTERNS.some((p) => p.test(trimmed));
}

/** Returns true if the message should be ignored (other bot output). */
function shouldIgnoreMessage(msg: NewMessage): boolean {
  if (IGNORE_SENDERS.size > 0 && IGNORE_SENDERS.has(msg.sender)) {
    return true;
  }
  if (isIgnoredTrigger(msg.content.trim())) {
    return true;
  }
  return false;
}

function compactMessage(text: string, maxLen = 220): string | undefined {
  let compact = text.trim();
  if (!compact) return undefined;
  if (TRIGGER_PATTERN.test(compact)) {
    compact = compact.replace(TRIGGER_PATTERN, '').trim();
  }
  compact = compact.replace(/\s+/g, ' ').trim();
  if (!compact) return undefined;
  return compact.length > maxLen ? `${compact.slice(0, maxLen)}...` : compact;
}

function setCurrentObjective(chatJid: string, objective: string): void {
  const compact = compactMessage(objective, 180);
  if (!compact) return;
  const activity = ensureChatActivity(chatJid);
  activity.currentObjective = compact;
  activity.currentObjectiveAt = Date.now();
  persistChatActivity(chatJid);
}

function recordUserContext(chatJid: string, text: string): void {
  const compact = compactMessage(text, 220);
  if (!compact) return;
  const activity = ensureChatActivity(chatJid);
  const existing = activity.recentUserContext || [];
  const next = [...existing.filter((v) => v !== compact), compact].slice(-6);
  activity.recentUserContext = next;
  persistChatActivity(chatJid);
}

function setObjectiveFromMessages(chatJid: string, messages: NewMessage[]): void {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const content = messages[i].content.trim();
    if (!content) continue;
    recordUserContext(chatJid, content);
    setCurrentObjective(chatJid, content);
    return;
  }
}

function markRunStarted(chatJid: string): void {
  const activity = ensureChatActivity(chatJid);
  activity.runStartedAt = Date.now();
  persistChatActivity(chatJid);
}

function markRunEnded(chatJid: string): void {
  const activity = ensureChatActivity(chatJid);
  activity.runStartedAt = undefined;
  persistChatActivity(chatJid);
}

function markProgress(chatJid: string, progress: string): void {
  const compact = compactMessage(progress);
  if (!compact) return;
  const activity = ensureChatActivity(chatJid);
  activity.lastProgress = compact;
  activity.lastProgressAt = Date.now();
  persistChatActivity(chatJid);
}

function markCompletion(chatJid: string, completion: string): void {
  const compact = compactMessage(completion);
  if (!compact) return;
  const activity = ensureChatActivity(chatJid);
  activity.lastCompletion = compact;
  activity.lastCompletionAt = Date.now();
  persistChatActivity(chatJid);
}

function markError(chatJid: string, error: string): void {
  const compact = compactMessage(error);
  if (!compact) return;
  const activity = ensureChatActivity(chatJid);
  activity.lastError = compact;
  activity.lastErrorAt = Date.now();
  persistChatActivity(chatJid);
}

function buildMainMissionContext(chatJid: string): string | undefined {
  const activity = ensureChatActivity(chatJid);
  const lines: string[] = [];

  if (activity.currentObjective) {
    lines.push(`Current objective: ${activity.currentObjective}`);
  }
  if (activity.recentUserContext && activity.recentUserContext.length > 0) {
    lines.push('Recent user context:');
    for (const item of activity.recentUserContext.slice(-4)) {
      lines.push(`- ${item}`);
    }
  }
  if (activity.lastCompletion) {
    lines.push(`Last completion: ${activity.lastCompletion}`);
  }
  if (activity.lastError) {
    lines.push(`Last error: ${activity.lastError}`);
  }

  if (lines.length === 0) return undefined;
  return [
    '[Persistent mission context - carry this forward unless user changes priorities]',
    ...lines,
  ].join('\n');
}


/**
 * Sync group .md files back to personas/ directory for version control.
 * Copies groups/{name}/*.md → personas/{PERSONA_NAME}/groups/{name}/
 */
function syncPersonas(): void {
  const rootDir = process.env.INFINICLAW_ROOT;
  const personaName = process.env.PERSONA_NAME;
  if (!rootDir || !personaName) return;

  const personaDir = path.join(rootDir, 'bots', 'personas', personaName);
  if (!fs.existsSync(personaDir)) return;

  try {
    const groupsBase = GROUPS_DIR;
    if (!fs.existsSync(groupsBase)) return;

    for (const gname of fs.readdirSync(groupsBase)) {
      const gdir = path.join(groupsBase, gname);
      if (!fs.statSync(gdir).isDirectory()) continue;

      for (const file of fs.readdirSync(gdir)) {
        if (!file.endsWith('.md')) continue;
        const dst = path.join(personaDir, 'groups', gname);
        fs.mkdirSync(dst, { recursive: true });
        fs.copyFileSync(path.join(gdir, file), path.join(dst, file));
      }
    }
    logger.info({ personaName }, 'Synced group memory to personas/');
  } catch (err) {
    logger.warn({ err, personaName }, 'Failed to sync personas on shutdown');
  }
}

let channels: Channel[] = [];
const queue = new GroupQueue();

/**
 * Check if outbound bot text matches the cross-bot pattern and forward it.
 * This enables bot-to-bot communication: when a bot says "@OtherBot <msg>",
 * the host forwards it to the other bot's room.
 */
async function maybeCrossBotForward(chatJid: string, text: string): Promise<void> {
  if (!CROSS_BOT_PATTERN || !CROSS_BOT_ROOM_JID) return;
  // Use non-anchored pattern — bot output may have preamble before the @mention
  const unanchored = new RegExp(CROSS_BOT_PATTERN.source.replace(/^\^/, ''), CROSS_BOT_PATTERN.flags);
  if (!unanchored.test(text)) return;
  const ch = findChannel(channels, CROSS_BOT_ROOM_JID);
  if (!ch) return;
  const group = registeredGroups[chatJid];
  const sourceName = group?.name || chatJid;
  const forwarded = `[From ${sourceName}] ${ASSISTANT_NAME}: ${text}`;
  try {
    await ch.sendMessage(CROSS_BOT_ROOM_JID, forwarded);
    logger.info({ chatJid, target: CROSS_BOT_ROOM_JID }, 'Forwarded cross-bot outbound message');
  } catch (err) {
    logger.warn({ chatJid, err }, 'Failed to forward cross-bot outbound message');
  }
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  const configuredMainModel = resolveConfiguredMainModel();
  const storedMainModel = normalizeMainLlm(getRouterState('main_model'));
  if (configuredMainModel) {
    const pinnedChanged =
      storedMainModel && configuredMainModel !== storedMainModel;
    mainLlm = configuredMainModel;
    setRouterState('main_model', mainLlm);

    // If model pin changed, drop the main session so Claude initializes fresh
    // on the requested model instead of resuming a prior-model session.
    if (pinnedChanged && sessions[MAIN_GROUP_FOLDER]) {
      deleteSession(MAIN_GROUP_FOLDER);
      delete sessions[MAIN_GROUP_FOLDER];
      logger.info(
        {
          fromModel: storedMainModel,
          toModel: configuredMainModel,
        },
        'Pinned MAIN model changed; cleared main session',
      );
    }
  } else if (storedMainModel) {
    mainLlm = storedMainModel;
  }
  logger.info(
    { groupCount: Object.keys(registeredGroups).length, mainModel: mainLlm },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState(
    'last_agent_timestamp',
    JSON.stringify(lastAgentTimestamp),
  );
  setRouterState('main_model', mainLlm);
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  const groupDir = path.join(DATA_DIR, '..', 'groups', group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && (c.jid.startsWith('matrix:') || c.jid.endsWith('@g.us')))
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(groups: Record<string, RegisteredGroup>): void {
  registeredGroups = groups;
}

/**
 * Append a brief entry to the group's conversation log.
 * Used for cross-channel context between WhatsApp and terminal sessions.
 */
function appendConversationLog(
  groupFolder: string,
  userMessages: NewMessage[],
  agentResponses: string[],
  channelName = 'matrix',
): void {
  if (userMessages.length === 0 && agentResponses.length === 0) return;

  const logDir = path.join(GROUPS_DIR, groupFolder, 'conversations');
  const logPath = path.join(logDir, 'log.md');
  fs.mkdirSync(logDir, { recursive: true });

  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const lines = ['---', `${timestamp} [${channelName}]`];

  for (const msg of userMessages) {
    const content = msg.content.length > 200
      ? msg.content.slice(0, 200) + '...'
      : msg.content;
    lines.push(`${msg.sender_name}: ${content}`);
  }

  for (const response of agentResponses) {
    const content = response.length > 200
      ? response.slice(0, 200) + '...'
      : response;
    lines.push(`${ASSISTANT_NAME}: ${content}`);
  }

  fs.appendFileSync(logPath, lines.join('\n') + '\n');

  // Trim to last 100 entries
  try {
    const full = fs.readFileSync(logPath, 'utf-8');
    const entries = full.split(/(?=^---$)/m).filter((e) => e.trim());
    if (entries.length > 100) {
      fs.writeFileSync(logPath, entries.slice(-100).join(''));
    }
  } catch {
    // Non-critical — log continues to grow until next successful trim
  }
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const allMissed = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (allMissed.length === 0) return true;
  const missedMessages = allMissed;

  // Filter out other-bot noise; everything else gets processed
  const filteredMessages = missedMessages.filter((msg) => !shouldIgnoreMessage(msg));
  if (filteredMessages.length === 0) return true;

  setObjectiveFromMessages(chatJid, filteredMessages);

  const basePrompt = formatMessages(filteredMessages);
  const missionContext =
    isMainGroup ? buildMainMissionContext(chatJid) : undefined;
  const parts: string[] = [];
  if (missionContext) parts.push(missionContext);
  parts.push(basePrompt);
  const prompt = parts.join('\n\n');

  // Advance cursor past ALL messages (including ignored) so we don't reprocess
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: filteredMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ group: group.name }, 'Idle timeout, closing container stdin');
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  const channel = findChannel(channels, chatJid);
  if (channel?.setTyping) await channel.setTyping(chatJid, true);
  if (channel?.setPresenceStatus) await channel.setPresenceStatus('online', 'processing...');
  let hadError = false;
  let outputSentToUser = false;
  const agentResponses: string[] = [];
  let lastResponseBody: string | undefined;
  let lastRunOutputAt = Date.now();
  let lastRunProgressNudgeAt = 0;
  let runProgressNudgeTimer: ReturnType<typeof setInterval> | null = null;

  markRunStarted(chatJid);

  // React to the last message to acknowledge we're working on it
  const lastMsg = missedMessages[missedMessages.length - 1];
  if (channel?.sendReaction && lastMsg?.id) {
    try {
      await channel.sendReaction(chatJid, lastMsg.id, ASSISTANT_REACTION);
    } catch (err) {
      logger.warn({ err, chatJid }, 'Failed to send working reaction');
    }
  }

  if (isMainGroup) {
    runProgressNudgeTimer = setInterval(() => {
      const now = Date.now();
      if (now - lastRunOutputAt < RUN_PROGRESS_NUDGE_STALE_MS) return;
      if (now - lastRunProgressNudgeAt < RUN_PROGRESS_NUDGE_COOLDOWN_MS) return;
      const nudged = queue.sendMessage(
        chatJid,
        'If you are still running, send a concise progress update now: done, in-progress, next.',
      );
      if (nudged) {
        lastRunProgressNudgeAt = now;
        logger.info({ chatJid }, 'Sent automatic run-progress nudge');
      }
    }, RUN_PROGRESS_NUDGE_CHECK_MS);
  }

  const runResult = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (group.folder === MAIN_GROUP_FOLDER && result.model) {
      updateMainLlm(result.model);
    }
    if (result.result) {
      const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      if (text) {
        lastRunOutputAt = Date.now();
        if (result.isProgress) {
          markProgress(chatJid, text);
          // Forward progress to chat with rate limiting
          const now = Date.now();
          if (!lastProgressChatAt[chatJid] || now - lastProgressChatAt[chatJid] >= PROGRESS_CHAT_COOLDOWN_MS) {
            lastProgressChatAt[chatJid] = now;
            const ch = findChannel(channels, chatJid);
            if (ch) {
              // Tool calls already have <small><details> formatting from agent-runner;
              // plain thinking text gets dimmed small italic
              const formatted = text.includes('<details>')
                ? text
                : `<small><font color="#888888"><em>${text}</em></font></small>`;
              void ch.sendMessage(chatJid, formatted).catch((err) => {
                logger.warn({ chatJid, err }, 'Failed to send progress to chat');
              });
            }
          }
        } else {
          // Final result: deliver to chat
          markProgress(chatJid, text);
          lastResponseBody = text;
          const ch = findChannel(channels, chatJid);
          if (ch) {
            await ch.sendMessage(chatJid, formatMainMessage(text));
          }
          await maybeCrossBotForward(chatJid, text);
          outputSentToUser = true;
          agentResponses.push(formatMainMessage(text));
        }
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'error') {
      hadError = true;
      if (result.error) {
        markError(chatJid, result.error);
      }
    }
  });

  if (channel?.setTyping) await channel.setTyping(chatJid, false);
  if (channel?.setPresenceStatus) await channel.setPresenceStatus('online', 'idle');
  if (idleTimer) clearTimeout(idleTimer);
  if (runProgressNudgeTimer) clearInterval(runProgressNudgeTimer);

  if (runResult.status === 'error' || hadError) {
    const rawError =
      runResult.error ||
      (hadError ? 'agent returned an error status' : 'unknown error');
    await maybeAutoSwitchBrainsOnQuotaError(rawError, chatJid);
    const compactError = rawError.replace(/\s+/g, ' ').slice(0, 1000);
    markError(chatJid, compactError);

    if (!outputSentToUser && channel) {
      const errorReply =
        formatMainMessage(
          `I hit an error while processing that request: ${compactError}`,
        );
      try {
        await channel.sendMessage(chatJid, errorReply);
        outputSentToUser = true;
        agentResponses.push(errorReply);
      } catch (sendErr) {
        logger.warn(
          { group: group.name, err: sendErr },
          'Failed to send error reply to channel',
        );
      }
    }

    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn({ group: group.name }, 'Agent error after output was sent, skipping cursor rollback to prevent duplicates');
      appendConversationLog(group.folder, missedMessages, agentResponses, channel?.name);
      markRunEnded(chatJid);
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn({ group: group.name }, 'Agent error, rolled back message cursor for retry');
    markRunEnded(chatJid);
    return false;
  }

  if (lastResponseBody) {
    markCompletion(chatJid, lastResponseBody);
  }
  markRunEnded(chatJid);

  appendConversationLog(group.folder, missedMessages, agentResponses, channel?.name);
  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<{ status: 'success' | 'error'; error?: string }> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionKey = group.folder;
  const sessionId = sessions[sessionKey];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[sessionKey] = output.newSessionId;
          setSession(sessionKey, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
      },
      (proc, containerName) => queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[sessionKey] = output.newSessionId;
      setSession(sessionKey, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return {
        status: 'error',
        error: output.error || 'container agent error',
      };
    }

    return { status: 'success' };
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

          // Filter out other-bot noise; everything else gets processed
          const filtered = groupMessages.filter((msg) => !shouldIgnoreMessage(msg));
          if (filtered.length === 0) continue;

          // --- Cross-bot @mention forwarding ---
          // Messages matching @OtherBot get forwarded to the other bot's room
          if (CROSS_BOT_PATTERN && CROSS_BOT_ROOM_JID) {
            const forOtherBot = filtered.filter((m) => CROSS_BOT_PATTERN!.test(m.content.trim()));
            if (forOtherBot.length > 0) {
              const ch = findChannel(channels, CROSS_BOT_ROOM_JID);
              if (ch) {
                for (const msg of forOtherBot) {
                  const forwarded = `[From ${group.name}] ${msg.sender_name}: ${msg.content}`;
                  try {
                    await ch.sendMessage(CROSS_BOT_ROOM_JID, forwarded);
                  } catch (err) {
                    logger.warn({ chatJid, err }, 'Failed to forward cross-bot message');
                  }
                }
                logger.info(
                  { chatJid, target: CROSS_BOT_ROOM_JID, count: forOtherBot.length },
                  'Forwarded cross-bot messages',
                );
              }
              // Remove forwarded messages from the set to process locally
              const forwardedIds = new Set(forOtherBot.map((m) => m.id));
              const forThisBot = filtered.filter((m) => !forwardedIds.has(m.id));
              if (forThisBot.length === 0) {
                // All messages were for other bot — advance cursor and skip
                lastAgentTimestamp[chatJid] = groupMessages[groupMessages.length - 1].timestamp;
                saveState();
                continue;
              }
              // Replace filtered with only this-bot messages for further processing
              filtered.length = 0;
              filtered.push(...forThisBot);
            }
          }

          // Pull all messages since lastAgentTimestamp so context is included
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          ).filter((msg) => !shouldIgnoreMessage(msg));
          const messagesToSend =
            allPending.length > 0 ? allPending : filtered;

          setObjectiveFromMessages(chatJid, messagesToSend);
          const formatted = formatMessages(messagesToSend);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            const now = Date.now();
            if (
              !lastActivePipeAckAt[chatJid] ||
              now - lastActivePipeAckAt[chatJid] >= ACTIVE_PIPE_ACK_COOLDOWN_MS
            ) {
              const ch = findChannel(channels, chatJid);
              if (ch) {
                const lastMessage = messagesToSend[messagesToSend.length - 1];
                if (ch.sendReaction && lastMessage?.id) {
                  void ch.sendReaction(chatJid, lastMessage.id, ASSISTANT_REACTION).catch((err) => {
                    logger.warn({ chatJid, err }, 'Failed to send active-run reaction acknowledgement');
                  });
                } else {
                  const objective = compactMessage(lastMessage?.content || '', 120);
                  void ch.sendMessage(
                    chatJid,
                    formatMainMessage(
                      `received and injected into active run.${objective ? ` request: ${objective}.` : ''}`,
                    ),
                  ).catch((err) => {
                    logger.warn({ chatJid, err }, 'Failed to send active-run acknowledgement');
                  });
                }
              }
              lastActivePipeAckAt[chatJid] = now;
            }
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing/presence indicator while the container processes the piped message
            const ch = findChannel(channels, chatJid);
            if (ch?.setTyping) await ch.setTyping(chatJid, true);
            if (ch?.setPresenceStatus) await ch.setPresenceStatus('online', 'processing...');
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
            const now = Date.now();
            if (
              !lastQueuedAckAt[chatJid] ||
              now - lastQueuedAckAt[chatJid] >= QUEUED_ACK_COOLDOWN_MS
            ) {
              const ch = findChannel(channels, chatJid);
              if (ch) {
                try {
                  const lastMessage = messagesToSend[messagesToSend.length - 1];
                  if (ch.sendReaction && lastMessage?.id) {
                    await ch.sendReaction(chatJid, lastMessage.id, ASSISTANT_REACTION);
                  } else {
                    const objective = compactMessage(
                      lastMessage?.content || '',
                      160,
                    );
                    await ch.sendMessage(
                      chatJid,
                      formatMainMessage(
                        `queued and starting run now.${objective ? ` objective: ${objective}.` : ''}`,
                      ),
                    );
                  }
                  lastQueuedAckAt[chatJid] = now;
                } catch (err) {
                  logger.warn(
                    { chatJid, err },
                    'Failed to send queued acknowledgement',
                  );
                }
              }
            }
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

/**
 * After any restart, inject a synthetic message into the main chat
 * so the agent re-enters the conversation instead of sitting idle.
 * Only injects if there are real pending messages to resume from.
 */
function injectResumeMessage(): void {
  const mainJid = Object.entries(registeredGroups).find(
    ([, g]) => g.folder === MAIN_GROUP_FOLDER,
  )?.[0];
  if (!mainJid) return;

  // Only inject if there are real pending messages — otherwise the bot
  // just responds "Done. Idle." which triggers a nudge feedback loop.
  const pending = getMessagesSince(
    mainJid,
    lastAgentTimestamp[mainJid] || '',
    ASSISTANT_NAME,
  );
  if (pending.length === 0) {
    logger.info({ mainJid }, 'No pending messages after restart — skipping resume injection');
    return;
  }

  storeMessage({
    id: `resume-${Date.now()}`,
    chat_jid: mainJid,
    chat_name: registeredGroups[mainJid].name,
    sender: 'system',
    sender_name: 'System',
    content: 'You just restarted. Check the conversation above for context and resume where you left off.',
    timestamp: new Date().toISOString(),
  });
  queue.enqueueMessageCheck(mainJid);
  logger.info({ mainJid, pendingCount: pending.length }, 'Injected resume message after restart');
}

type PodmanMachineListEntry = {
  Name: string;
  Default?: boolean;
  Running?: boolean;
  Starting?: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function canReachPodmanApi(): boolean {
  try {
    execSync('podman info', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function podmanCommandSucceeded(args: string[]): boolean {
  const result = spawnSync('podman', args, { stdio: 'ignore' });
  return result.status === 0;
}

function ensurePodmanImageAvailable(): void {
  if (podmanCommandSucceeded(['image', 'exists', CONTAINER_IMAGE])) {
    logger.debug({ image: CONTAINER_IMAGE }, 'Podman image available');
    return;
  }

  const dockerfilePath = path.join(process.cwd(), 'container', 'Dockerfile');
  const buildContext = path.join(process.cwd(), 'container');
  if (!fs.existsSync(dockerfilePath) || !fs.existsSync(buildContext)) {
    throw new Error(
      `Container image ${CONTAINER_IMAGE} missing and build context not found`,
    );
  }

  logger.warn({ image: CONTAINER_IMAGE }, 'Podman image missing; rebuilding');
  const buildResult = spawnSync(
    'podman',
    ['build', '-t', CONTAINER_IMAGE, '-f', dockerfilePath, buildContext],
    {
      stdio: 'inherit',
      timeout: 30 * 60 * 1000,
    },
  );

  if (buildResult.error) {
    throw new Error(
      `Failed to rebuild container image ${CONTAINER_IMAGE}: ${buildResult.error.message}`,
    );
  }

  if (buildResult.status !== 0) {
    throw new Error(
      `Failed to rebuild container image ${CONTAINER_IMAGE} (exit code ${buildResult.status ?? 'unknown'})`,
    );
  }

  if (!podmanCommandSucceeded(['image', 'exists', CONTAINER_IMAGE])) {
    throw new Error(
      `Container image ${CONTAINER_IMAGE} is still missing after rebuild`,
    );
  }

  logger.info({ image: CONTAINER_IMAGE }, 'Podman image rebuilt and ready');
}

async function waitForPodmanApi(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (canReachPodmanApi()) return true;
    await sleep(1000);
  }
  return canReachPodmanApi();
}

function getPodmanMachines(): PodmanMachineListEntry[] {
  const output = execSync('podman machine list --format json', {
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  const parsed: unknown = JSON.parse(output || '[]');
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (item): item is PodmanMachineListEntry =>
      !!item &&
      typeof item === 'object' &&
      'Name' in item &&
      typeof (item as { Name: unknown }).Name === 'string',
  );
}

function selectPodmanMachine(machines: PodmanMachineListEntry[]): PodmanMachineListEntry | undefined {
  return machines.find((m) => m.Default) || machines[0];
}

async function ensurePodmanRuntimeAvailable(): Promise<void> {
  if (await waitForPodmanApi(2000)) {
    logger.debug('Podman runtime available');
    return;
  }

  logger.warn('Podman runtime unavailable; attempting machine recovery');

  let machineName = 'podman-machine-default';
  try {
    const machine = selectPodmanMachine(getPodmanMachines());
    if (!machine) {
      throw new Error('No podman machine exists. Run: podman machine init');
    }
    machineName = machine.Name;
    if (machine.Starting && !machine.Running) {
      logger.warn({ machineName }, 'Podman machine stuck in starting state; forcing stop');
      try {
        execSync(`podman machine stop ${machineName}`, { stdio: 'pipe', timeout: 30000 });
      } catch {
        // Best effort: a stale "starting" state may not stop cleanly.
      }
    } else if (machine.Running) {
      logger.warn({ machineName }, 'Podman machine reports running but API is unavailable; restarting');
      try {
        execSync(`podman machine stop ${machineName}`, { stdio: 'pipe', timeout: 30000 });
      } catch {
        // Best effort before restart.
      }
    }

    execSync(`podman machine start ${machineName}`, { stdio: 'pipe', timeout: 180000 });
  } catch (err) {
    logger.error({ err, machineName }, 'Failed to start Podman machine');
    throw err;
  }

  if (await waitForPodmanApi(120000)) {
    logger.info({ machineName }, 'Podman runtime recovered');
    return;
  }

  throw new Error('Podman machine started but API did not become ready');
}

function cleanupOrphanedPodmanContainers(): void {
  try {
    const output = execSync('podman ps --format json', {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const containers: Array<{ Names?: string[] | string }> = JSON.parse(
      output || '[]',
    );
    const names = containers.flatMap((c) => {
      if (Array.isArray(c.Names)) return c.Names;
      return c.Names ? [c.Names] : [];
    });
    const botTag = (ASSISTANT_NAME || 'bot').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    const ownPrefix = `nanoclaw-${botTag}-`;
    const orphans = names.filter((n) => n.startsWith(ownPrefix));
    for (const name of orphans) {
      try {
        execSync(`podman stop -t 1 ${name}`, { stdio: 'pipe' });
      } catch {
        // Best-effort cleanup
      }
    }
    if (orphans.length > 0) {
      logger.info({ count: orphans.length, names: orphans }, 'Stopped orphaned podman containers');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned podman containers');
  }
}

async function ensureContainerSystemRunning(): Promise<void> {
  try {
    await ensurePodmanRuntimeAvailable();
    cleanupOrphanedPodmanContainers();
    ensurePodmanImageAvailable();
  } catch (err) {
    logger.error({ err }, 'Podman runtime/image setup failed');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Podman setup failed                                     ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Could not start Podman runtime or prepare container image.    ║',
    );
    console.error(
      '║  Check: podman machine list / podman machine start             ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Podman is required but not available');
  }
}

async function main(): Promise<void> {
  // Load supplemental env from .env.local (for vars not in launchd plist)
  const envLocalPath = path.join(process.cwd(), '.env.local');
  if (fs.existsSync(envLocalPath)) {
    for (const line of fs.readFileSync(envLocalPath, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!process.env[key]) process.env[key] = val;
    }
  }
  // Ensure common tool paths are available (launchd provides minimal PATH)
  for (const p of ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin']) {
    if (!(process.env.PATH || '').includes(p)) {
      process.env.PATH = `${p}:${process.env.PATH || ''}`;
    }
  }
  await ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    for (const ch of channels) {
      if (ch.setPresenceStatus) await ch.setPresenceStatus('offline', 'shutting down...');
    }
    syncPersonas();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Create Matrix channel (activates only if configured)
  let matrix: MatrixChannel | null = null;
  if (
    MATRIX_HOMESERVER &&
    (MATRIX_ACCESS_TOKEN || (MATRIX_USERNAME && MATRIX_PASSWORD))
  ) {
    matrix = new MatrixChannel({
      onMessage: (_chatJid, msg) => {
        ensureGroupForIncomingChat(msg.chat_jid, msg.chat_name);
        storeMessage(msg);
      },
      onChatMetadata: (chatJid, timestamp, name) => {
        ensureGroupForIncomingChat(chatJid, name);
        storeChatMetadata(chatJid, timestamp, name);
      },
      registeredGroups: () => registeredGroups,
    });
  }

  let localCli: LocalCliChannel | null = null;
  if (LOCAL_CHANNEL_ENABLED) {
    localCli = new LocalCliChannel({
      onMessage: (_chatJid, msg) => {
        ensureGroupForIncomingChat(msg.chat_jid, msg.chat_name);
        storeMessage(msg);
      },
      onChatMetadata: (chatJid, timestamp, name) =>
        storeChatMetadata(chatJid, timestamp, name),
      mirrorToMatrix: LOCAL_MIRROR_MATRIX_JID
        ? async (text: string) => {
            if (!matrix || !matrix.isConnected()) return;
            await matrix.sendMessage(LOCAL_MIRROR_MATRIX_JID, text);
          }
        : undefined,
    });
  }

  // Build channels array (only include connected channels)
  const allChannels: (Channel | null)[] = [localCli, matrix];
  const refreshConnectedChannels = () => {
    channels = allChannels.filter((ch): ch is Channel => ch != null && ch.isConnected());
  };
  refreshConnectedChannels();

  if (localCli) {
    try {
      await localCli.connect();
    } catch (err) {
      logger.error({ err }, 'Local CLI channel connect failed');
    }
    refreshConnectedChannels();
  }

  // Connect channels
  if (matrix) {
    // Do not block local terminal startup on Matrix/network connectivity.
    void matrix.connect().catch((err) => {
      logger.error({ err }, 'Initial Matrix connection failed; continuing in degraded mode');
    });
    refreshConnectedChannels();

    let matrixReconnectInProgress = false;
    setInterval(async () => {
      if (!matrix || matrixReconnectInProgress) return;
      matrixReconnectInProgress = true;
      try {
        const healthy = await matrix.checkHealth();
        if (!healthy) {
          await matrix.connect();
          if (matrix.isConnected()) {
            logger.info('Matrix reconnected');
          }
        }
      } catch (err) {
        logger.warn({ err }, 'Matrix reconnect attempt failed');
      } finally {
        refreshConnectedChannels();
        matrixReconnectInProgress = false;
      }
    }, MATRIX_RECONNECT_INTERVAL);
  }

  // Memory watchdog — gracefully recycle before OOM
  const heapLimitBytes = HEAP_LIMIT_MB * 1024 * 1024;
  const heartbeatPath = path.join(DATA_DIR, 'heartbeat');
  setInterval(() => {
    const usage = process.memoryUsage();
    const heapMB = Math.round(usage.heapUsed / 1024 / 1024);
    const rssMB = Math.round(usage.rss / 1024 / 1024);
    logger.info({ heapMB, rssMB, limitMB: HEAP_LIMIT_MB }, 'Memory');
    // Write heartbeat so external tooling can detect a stuck event loop
    try { fs.writeFileSync(heartbeatPath, String(Date.now())); } catch {}
    if (usage.heapUsed > heapLimitBytes) {
      logger.warn({ heapMB, limitMB: HEAP_LIMIT_MB }, 'Heap limit exceeded, recycling');
      shutdown('HEAP_LIMIT');
    }
  }, MEMORY_CHECK_INTERVAL);
  // Write initial heartbeat
  try { fs.writeFileSync(heartbeatPath, String(Date.now())); } catch {}

  // Periodic status snapshot for containers to read via check_health MCP tool
  const STATUS_SNAPSHOT_INTERVAL = 30_000;
  const writeStatusSnapshot = () => {
    try {
      const snapshot = {
        timestamp: new Date().toISOString(),
        bot: ASSISTANT_NAME,
        role: ASSISTANT_ROLE,
        model: mainLlm,
        provider: MAIN_PROVIDER,
        brainModes: {
          engineer: readBrainMode('engineer'),
          commander: readBrainMode('commander'),
        },
        groups: Object.entries(registeredGroups).map(([jid, g]) => {
          const queueStatus = queue.getGroupStatus(jid);
          const activity = chatActivity[jid] || {};
          return {
            jid,
            name: g.name,
            folder: g.folder,
            active: queueStatus.active,
            hasProcess: queueStatus.hasProcess,
            containerName: queueStatus.containerName,
            pendingMessages: queueStatus.pendingMessages,
            pendingTasks: queueStatus.pendingTasks,
            currentObjective: activity.currentObjective,
            lastProgress: activity.lastProgress,
            lastProgressAt: activity.lastProgressAt,
            lastError: activity.lastError,
            lastErrorAt: activity.lastErrorAt,
          };
        }),
      };

      for (const [, g] of Object.entries(registeredGroups)) {
        const ipcDir = path.join(DATA_DIR, 'ipc', g.folder);
        if (!fs.existsSync(ipcDir)) continue;
        const statusPath = path.join(ipcDir, 'status.json');
        const tmpPath = `${statusPath}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2));
        fs.renameSync(tmpPath, statusPath);
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to write status snapshot');
    }
  };
  writeStatusSnapshot();
  setInterval(writeStatusSnapshot, STATUS_SNAPSHOT_INTERVAL);

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) => queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const ch = findChannel(channels, jid);
      if (!ch) return;
      const text = stripInternalTags(rawText);
      if (text) {
        await ch.sendMessage(jid, formatMainMessage(text));
        await maybeCrossBotForward(jid, text);
      }
    },
  });
  startIpcWatcher({
    sendMessage: async (jid, text) => {
      const ch = findChannel(channels, jid);
      if (!ch) {
        logger.warn({ jid }, 'No channel found for IPC message');
        return;
      }
      await ch.sendMessage(jid, text);
      await maybeCrossBotForward(jid, text);
    },
    defaultSenderForGroup,
    sendImage: (jid, buffer, filename, mimetype, caption) => {
      const ch = findChannel(channels, jid);
      if (ch?.sendImage) return ch.sendImage(jid, buffer, filename, mimetype, caption);
      logger.warn({ jid }, 'No channel with image support found for IPC image');
      return Promise.resolve();
    },
    sendFile: (jid, buffer, filename, mimetype, caption) => {
      const ch = findChannel(channels, jid);
      if (ch?.sendFile) return ch.sendFile(jid, buffer, filename, mimetype, caption);
      logger.warn({ jid }, 'No channel with file support found for IPC file');
      return Promise.resolve();
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: async () => {},
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  injectResumeMessage();
  startMessageLoop();

  // Send boot announcement once main channel is available
  const bootAnnounceTimer = setInterval(async () => {
    const mainJid = getMainChatJid();
    if (!mainJid) return;
    const ch = findChannel(channels, mainJid);
    if (!ch) return;
    clearInterval(bootAnnounceTimer);
    try {
      if (ch.setPresenceStatus) await ch.setPresenceStatus('online', 'idle');
      await ch.sendMessage(mainJid, `✅ <font color="#00cc00">online.</font>\n\n${mainSender()}`);
    } catch (err) {
      logger.warn({ err }, 'Failed to send boot announcement');
    }
  }, 2000);

}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
