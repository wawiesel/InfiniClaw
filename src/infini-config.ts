/**
 * InfiniClaw-specific config values.
 * These were removed from upstream NanoClaw config in v1.2.2
 * (moved to channel modules or removed entirely).
 */
import { escapeRegex } from './utils.js';

export const ASSISTANT_ROLE = process.env.ASSISTANT_ROLE || '';
export const CAPTAIN_USER_ID = process.env.CAPTAIN_USER_ID || '';
export const OPERATOR_USER_ID = process.env.OPERATOR_USER_ID || '';
export const MAIN_GROUP_FOLDER = process.env.MAIN_GROUP_FOLDER || 'main';
// Max time the main brain may run per turn before being killed (0 = disabled).
// Enforces the dispatch model: main brain triages, Thread Brain works.
export const MAIN_BRAIN_TURN_TIMEOUT_MS = parseInt(process.env.MAIN_BRAIN_TURN_TIMEOUT_MS || '90000', 10);
// Max inline tool calls before a dispatch warning is injected into the running container.
export const MAIN_BRAIN_TOOL_LIMIT = parseInt(process.env.MAIN_BRAIN_TOOL_LIMIT || '3', 10);
export const HEAP_LIMIT_MB = parseInt(process.env.HEAP_LIMIT_MB || '0', 10);
export const RESUME_DELAY_SECONDS = parseInt(process.env.RESUME_DELAY_SECONDS || '0', 10);
export const MEMORY_CHECK_INTERVAL = parseInt(process.env.MEMORY_CHECK_INTERVAL || '120000', 10);

// Matrix channel config
export const MATRIX_HOMESERVER = process.env.MATRIX_HOMESERVER || '';
export const MATRIX_USERNAME = process.env.MATRIX_USERNAME || '';
export const MATRIX_PASSWORD = process.env.MATRIX_PASSWORD || '';
export const MATRIX_ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN || '';
export const MATRIX_RECONNECT_INTERVAL = parseInt(process.env.MATRIX_RECONNECT_INTERVAL || '5000', 10);
export const MATRIX_DEVICE_NAME = process.env.MATRIX_DEVICE_NAME || '';
export const MATRIX_USER_ID = process.env.MATRIX_USER_ID || '';

// Message filtering
const ignoreTriggerStr = (process.env.IGNORE_TRIGGERS || '').trim();
export const IGNORE_PATTERNS: RegExp[] = ignoreTriggerStr
  ? ignoreTriggerStr.split(',').map((t) => {
      const cleaned = t.trim().replace(/^@/, '');
      return new RegExp(`\\b${escapeRegex(cleaned)}\\b`, 'i');
    })
  : [];

const ignoreSendersStr = (process.env.IGNORE_SENDERS || '').trim();
export const IGNORE_SENDERS: Set<string> = new Set(
  ignoreSendersStr ? ignoreSendersStr.split(',').map((s) => s.trim()).filter(Boolean) : [],
);

/** Validate critical config at startup. Logs warnings for empty required values. */
export function validateConfig(): string[] {
  const warnings: string[] = [];
  if (!CAPTAIN_USER_ID) warnings.push('CAPTAIN_USER_ID is empty — operator commands will be unrestricted');
  if (!MATRIX_HOMESERVER) warnings.push('MATRIX_HOMESERVER is empty — Matrix channel will not connect');
  if (MATRIX_HOMESERVER && !MATRIX_USERNAME && !MATRIX_ACCESS_TOKEN) warnings.push('MATRIX_HOMESERVER set but no MATRIX_USERNAME or MATRIX_ACCESS_TOKEN');
  if (HEAP_LIMIT_MB < 0) warnings.push(`HEAP_LIMIT_MB is negative (${HEAP_LIMIT_MB})`);
  if (MEMORY_CHECK_INTERVAL < 10_000) warnings.push(`MEMORY_CHECK_INTERVAL too low (${MEMORY_CHECK_INTERVAL}ms) — may cause excessive logging`);
  return warnings;
}
