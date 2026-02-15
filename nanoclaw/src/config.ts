import path from 'path';

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Andy';
export const POLL_INTERVAL = Math.max(
  100,
  parseInt(process.env.POLL_INTERVAL || '250', 10) || 250,
);
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || '/Users/user';

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = 'main';

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_RUNTIME =
  (process.env.CONTAINER_RUNTIME || 'container').toLowerCase();
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CONTAINER_MEMORY_MB = parseInt(
  process.env.CONTAINER_MEMORY_MB || '0',
  10,
); // 0 = runtime default (no explicit limit)
export const CONTAINER_CPUS = parseFloat(
  process.env.CONTAINER_CPUS || '0',
); // 0 = runtime default (no explicit limit)
export const IPC_POLL_INTERVAL = Math.max(
  50,
  parseInt(process.env.IPC_POLL_INTERVAL || '200', 10) || 200,
);
export const IDLE_TIMEOUT = parseInt(
  process.env.IDLE_TIMEOUT || '1800000',
  10,
); // 30min default — how long to keep container alive after last result
export const HEAP_LIMIT_MB = parseInt(
  process.env.HEAP_LIMIT_MB || '1536',
  10,
); // Graceful restart threshold
export const MEMORY_CHECK_INTERVAL = 60_000; // Check every 60s
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Matrix channel configuration
export const MATRIX_HOMESERVER = process.env.MATRIX_HOMESERVER || '';
export const MATRIX_ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN || '';
export const MATRIX_USER_ID = process.env.MATRIX_USER_ID || '';
export const MATRIX_USERNAME = process.env.MATRIX_USERNAME || '';
export const MATRIX_PASSWORD = process.env.MATRIX_PASSWORD || '';
export const MATRIX_DEVICE_NAME =
  process.env.MATRIX_DEVICE_NAME || 'nanoclaw-bot';
export const MATRIX_RECONNECT_INTERVAL = parseInt(
  process.env.MATRIX_RECONNECT_INTERVAL || '30000',
  10,
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
