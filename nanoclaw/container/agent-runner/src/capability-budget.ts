/**
 * InfiniClaw capability budget tracking.
 * Token budgeting for delegate providers (codex, gemini, ollama).
 */
import fs from 'fs';
import path from 'path';

const CAPABILITY_STATE_FILE = '/workspace/cache/capability-budget-state.json';

export type CapabilityState = {
  budgets: Record<string, number>;
  used: Record<string, number>;
};

export function capabilityKey(provider: string, model: string): string {
  return `${provider.trim().toLowerCase()}:${model.trim()}`;
}

export function estimateTokens(text: string): number {
  const normalized = (text || '').trim();
  if (!normalized) return 0;
  return Math.max(1, Math.ceil(normalized.length / 4));
}

export function loadCapabilityState(): CapabilityState {
  try {
    if (!fs.existsSync(CAPABILITY_STATE_FILE)) {
      return { budgets: {}, used: {} };
    }
    const parsed = JSON.parse(fs.readFileSync(CAPABILITY_STATE_FILE, 'utf-8')) as Partial<CapabilityState>;
    return {
      budgets: parsed.budgets || {},
      used: parsed.used || {},
    };
  } catch {
    return { budgets: {}, used: {} };
  }
}

export function saveCapabilityState(state: CapabilityState): void {
  fs.mkdirSync(path.dirname(CAPABILITY_STATE_FILE), { recursive: true });
  const tmp = `${CAPABILITY_STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, CAPABILITY_STATE_FILE);
}

export function recordCapabilityUsage(provider: string, model: string, tokens: number): void {
  if (tokens <= 0) return;
  const key = capabilityKey(provider, model);
  const state = loadCapabilityState();
  state.used[key] = (state.used[key] || 0) + tokens;
  saveCapabilityState(state);
}

export function listCapabilityUsageLines(): string[] {
  const state = loadCapabilityState();
  const keys = Array.from(
    new Set([...Object.keys(state.budgets), ...Object.keys(state.used)]),
  ).sort();
  if (keys.length === 0) {
    return ['No capability budgets configured yet.'];
  }
  return keys.map((key) => {
    const [provider, ...modelParts] = key.split(':');
    const model = modelParts.join(':');
    const used = state.used[key] || 0;
    const total = state.budgets[key];
    const remaining =
      typeof total === 'number' && total >= 0 ? Math.max(0, total - used) : null;
    return `${provider}/${model}: used=${used} tokens, remaining=${remaining === null ? 'unknown' : `${remaining} tokens`}`;
  });
}
