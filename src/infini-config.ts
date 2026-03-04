/**
 * InfiniClaw-specific config values.
 * These were removed from upstream NanoClaw config in v1.2.2
 * (moved to channel modules or removed entirely).
 */

export const ASSISTANT_ROLE = process.env.ASSISTANT_ROLE || '';
export const CAPTAIN_USER_ID = process.env.CAPTAIN_USER_ID || '';
export const MAIN_GROUP_FOLDER = process.env.MAIN_GROUP_FOLDER || 'main';
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

// Local CLI channel
export const LOCAL_CHAT_JID = 'local:cli';
export const LOCAL_CHAT_NAME = 'Local CLI';
export const LOCAL_CHAT_SENDER_NAME = process.env.LOCAL_CHAT_SENDER_NAME || 'God';

// Local channel config
export const LOCAL_CHANNEL_ENABLED = process.env.LOCAL_CHANNEL_ENABLED === '1' || process.env.LOCAL_CHANNEL_ENABLED === 'true';
export const LOCAL_MIRROR_MATRIX_JID = process.env.LOCAL_MIRROR_MATRIX_JID || '';

// Message filtering
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ignoreTriggerStr = (process.env.IGNORE_TRIGGERS || '').trim();
export const IGNORE_PATTERNS: RegExp[] = ignoreTriggerStr
  ? ignoreTriggerStr.split(',').map((t) => {
      const cleaned = t.trim().replace(/^@/, '');
      return new RegExp(`^@?${escapeRegex(cleaned)}\\b`, 'i');
    })
  : [];

const ignoreSendersStr = (process.env.IGNORE_SENDERS || '').trim();
export const IGNORE_SENDERS: Set<string> = new Set(
  ignoreSendersStr ? ignoreSendersStr.split(',').map((s) => s.trim()).filter(Boolean) : [],
);
