import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { shellQuote } from './utils.js';
import { loadShipConfig, loadFleet } from './ship-config.js';

const PM2_BIN = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'node_modules', '.bin', 'pm2');

export function pm2Name(bot: string): string {
  return `infiniclaw-${bot}`;
}

export function pm2Stop(name: string): void {
  try {
    execFileSync(PM2_BIN, ['delete', name], { stdio: 'pipe' });
  } catch { /* ok */ }
}

export function pm2StartBot(bot: string, nodeBin: string, instance: string, logs: string, root: string): void {
  const name = pm2Name(bot);
  pm2Stop(name);

  // Write start script that sources env file at runtime
  const startScript = path.join(instance, 'start.sh');
  const config = loadShipConfig();
  const envFile = path.join(config.secretsPath, 'bots', bot, 'env');
  const pathVal = `${path.dirname(process.execPath)}:${os.homedir()}/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin`;

  const scriptContent = `#!/bin/bash
set -a
source ${shellQuote(envFile)}
set +a
export PERSONA_NAME=${shellQuote(bot)}
export INFINICLAW_ROOT=${shellQuote(root)}
export PATH=${shellQuote(pathVal)}
export HOME=${shellQuote(os.homedir())}
CAPTAIN_FILE=${shellQuote(path.join(config.secretsPath, 'captain'))}
if [ -f "$CAPTAIN_FILE" ]; then
  source "$CAPTAIN_FILE"
  export CAPTAIN_USER_ID
fi
export ANTHROPIC_MODEL="\${BRAIN_MODEL:-}"
if [ -n "\${BRAIN_BASE_URL:-}" ]; then
  export ANTHROPIC_SMALL_FAST_MODEL="\${BRAIN_MODEL:-}"
  export ANTHROPIC_DEFAULT_SONNET_MODEL="\${BRAIN_MODEL:-}"
fi
export ANTHROPIC_BASE_URL="\${BRAIN_BASE_URL:-}"
export ANTHROPIC_AUTH_TOKEN="\${BRAIN_AUTH_TOKEN:-}"
export ANTHROPIC_API_KEY="\${BRAIN_API_KEY:-}"
export CLAUDE_CODE_OAUTH_TOKEN="\${BRAIN_OAUTH_TOKEN:-}"
if [ -n "\${BRAIN_CA_CERT_FILE:-}" ]; then
  export NODE_EXTRA_CA_CERTS="\${BRAIN_CA_CERT_FILE}"
fi
exec ${shellQuote(nodeBin)} ${shellQuote(path.join(instance, 'dist', 'main.js'))}
`;
  fs.writeFileSync(startScript, scriptContent, { mode: 0o755 });

  const outLog = path.join(logs, `${bot}.log`);
  const errLog = path.join(logs, `${bot}.error.log`);

  execFileSync(
    PM2_BIN,
    [
      'start',
      '/bin/bash',
      '--name', name,
      '--cwd', instance,
      '--output', outLog,
      '--error', errLog,
      '--restart-delay', '2000',
      '--max-restarts', '100',
      '--',
      startScript,
    ],
    { stdio: 'inherit' },
  );
}

export function killRogueProcesses(): void {
  try {
    const output = execSync("pgrep -f 'nanoclaw.*dist/main\\.js'", {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    for (const pid of output.trim().split('\n').filter(Boolean)) {
      try { process.kill(parseInt(pid, 10)); } catch { /* best effort */ }
    }
  } catch { /* ok */ }
}
