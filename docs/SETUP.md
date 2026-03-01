# New Machine Setup Guide

Step-by-step runbook for deploying InfiniClaw on a new Mac. Written so another Claude Code instance can execute it without external docs.

## 1. Prerequisites

Install these on the new machine:

```bash
# Homebrew
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Node.js 22+ via nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
nvm install 22
nvm use 22

# Podman Desktop (container runtime — no Docker)
brew install podman-desktop
podman machine init
podman machine set --memory 24576   # 24GB VM — must exceed CONTAINER_MEMORY_MB
podman machine start

# Claude Code CLI
npm install -g @anthropic-ai/claude-code
```

Verify:
```bash
node --version    # v22+
podman --version  # 5.x+
claude --version
```

## 2. Clone Repos

```bash
# InfiniClaw (includes nanoclaw in external/)
git clone git@github.com:wawiesel/InfiniClaw.git ~/2026-Nanoclaw/InfiniClaw

# Vault — shared knowledge base
git clone git@code.ornl.gov:ww5/vault.git ~/_vault

# AEGIS — shared Python library
git clone https://code.ornl.gov/ww5/aegis.git ~/2025-AEGIS

# Secrets — bot env files (private)
git clone git@code.ornl.gov:ww5/infiniclaw-secrets.git ~/.config/infiniclaw/secrets

# WKS — workspace manager
git clone https://github.com/wawiesel/wks.git ~/2025-WKS/main
```

## 3. Install Dependencies

```bash
cd ~/2026-Nanoclaw/InfiniClaw
npm ci
npm run build
```

## 4. Create machine.json

This tells InfiniClaw which bots run on this machine and where secrets live.

```bash
mkdir -p ~/.config/infiniclaw
```

Write `~/.config/infiniclaw/machine.json`:

```json
{
  "bots": ["cid", "johnny5", "albert"],
  "secretsPath": "/Users/YOUR_USERNAME/.config/infiniclaw/secrets"
}
```

Replace `YOUR_USERNAME` with the actual macOS username. The `bots` array lists persona names — these must match the directory names in `bots/personas/` and `secrets/`. Remove any that should stay on the other machine.

## 5. Create allow-list.json

This controls which host directories each bot gets mounted read-write at `/workspace/extra/`.

Write `~/.config/infiniclaw/allow-list.json`:

```json
{
  "mounts": {
    "cid": [
      {
        "path": "~/2026-Nanoclaw/InfiniClaw",
        "expiresAt": null
      },
      {
        "path": "~/2025-AEGIS",
        "expiresAt": null
      }
    ],
    "johnny5": [
      {
        "path": "~/_vault",
        "expiresAt": null
      }
    ],
    "albert": [
      {
        "path": "~/2026-Nanoclaw/InfiniClaw",
        "expiresAt": null
      },
      {
        "path": "~/2025-AEGIS",
        "expiresAt": null
      }
    ]
  }
}
```

Paths use `~` which resolves at runtime. The `expiresAt: null` means permanent. Temporary mounts (granted via `!allow` in Matrix) get an ISO timestamp here.

## 6. Set Up Secrets

Bot env files (API keys, Matrix credentials) live in a separate private repo. If you cloned `infiniclaw-secrets` in step 2 and pointed `machine.json` `secretsPath` at it in step 4, secrets are already in place.

To verify:
```bash
ls ~/.config/infiniclaw/secrets/cid/env
ls ~/.config/infiniclaw/secrets/johnny5/env
ls ~/.config/infiniclaw/secrets/albert/env
```

If setting up from scratch without the secrets repo, create env files for each bot with at minimum:
- `BRAIN_OAUTH_TOKEN` — Anthropic OAuth token
- `MATRIX_HOMESERVER`, `MATRIX_USERNAME`, `MATRIX_PASSWORD` — Matrix credentials
- `CONTAINER_IMAGE` — e.g. `nanoclaw-cid:latest`
- `CONTAINER_ENV_PYTHONPATH=/workspace/extra/2025-AEGIS/source`

### Container Environment Injection

Any env var in a bot's profile `env` file prefixed with `CONTAINER_ENV_` gets the prefix stripped and passed as `-e KEY=VALUE` to the podman container at runtime. This decouples container images from host-specific paths.

For example, `CONTAINER_ENV_PYTHONPATH=/workspace/extra/2025-AEGIS/source` in the profile env becomes `-e PYTHONPATH=/workspace/extra/2025-AEGIS/source` on the podman run command.

## 7. Build Container Images

```bash
cd ~/2026-Nanoclaw/InfiniClaw
./bots/container/build.sh all
```

This builds `nanoclaw-cid:latest`, `nanoclaw-johnny5:latest`, `nanoclaw-nora:latest`, `nanoclaw-parker:latest`, and `nanoclaw-albert:latest` via Podman.

Verify:
```bash
podman images --filter reference='nanoclaw-*'
```

## 8. MinIO (Optional — Shared State Sync)

Only needed if this machine will host the S3 state store, or if you want to sync bot state between machines.

### On the machine hosting MinIO:

```bash
cd ~/2026-Nanoclaw/InfiniClaw
./scripts/setup-minio.sh
```

Then create the bucket:
```bash
podman exec minio mc alias set local http://localhost:9000 minioadmin minioadmin
podman exec minio mc mb local/infiniclaw
```

### Add S3 config to machine.json on BOTH machines:

```json
{
  "bots": ["cid", "johnny5", "albert"],
  "secretsPath": "/Users/YOUR_USERNAME/.config/infiniclaw/secrets",
  "s3": {
    "endpoint": "http://MINIO_HOST_IP:9000",
    "bucket": "infiniclaw",
    "accessKey": "minioadmin",
    "secretKey": "minioadmin"
  }
}
```

Replace `MINIO_HOST_IP` with the LAN IP of the machine running MinIO (e.g. `192.168.1.x`). Both machines point to the same MinIO instance.

## 9. Start Proxies

WKSM and SCALEMAN are MCP proxies that run independently of InfiniClaw. Bots connect to them via SSE.

### WKSM (port 8765)

Requires WKS installed (`wksc` in PATH):
```bash
wksc mcp proxy start
```

### Google Workspace MCP (port 8767)

Provides Gmail, Calendar, and Drive tools to bots. Requires a Python venv with `workspace-mcp` installed and Google OAuth credentials.

**Install:**
```bash
python3 -m venv ~/.venv
~/.venv/bin/pip install workspace-mcp
```

**Google OAuth setup:**
1. Create OAuth credentials at https://console.cloud.google.com/ (Desktop app type)
2. Save the client JSON to `~/.config/infiniclaw/secrets/johnny5/google-credentials.json`
3. Run once interactively to complete the browser OAuth flow:
   ```bash
   GOOGLE_OAUTH_CLIENT_ID="your-client-id" \
   GOOGLE_OAUTH_CLIENT_SECRET="your-client-secret" \
   GOOGLE_MCP_CREDENTIALS_DIR="$HOME/.config/infiniclaw/secrets/johnny5" \
   USER_GOOGLE_EMAIL="you@gmail.com" \
   OAUTHLIB_INSECURE_TRANSPORT=1 \
   ~/.venv/bin/workspace-mcp --tools gmail calendar drive --single-user
   ```
4. Complete the browser auth. A token file (`you@gmail.com.json`) will be saved to the credentials dir.

**Run as launchd service:**

Create `~/Library/LaunchAgents/com.wieselquist.workspace-mcp.plist` — see the existing plist on mac139160 for the full template. Key env vars:
- `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` — from OAuth credentials
- `GOOGLE_MCP_CREDENTIALS_DIR` — directory containing the token file
- `USER_GOOGLE_EMAIL` — the Google account email
- `WORKSPACE_MCP_PORT=8767`

```bash
launchctl load ~/Library/LaunchAgents/com.wieselquist.workspace-mcp.plist
```

**Bot MCP config** (in `.mcp.json`):
```json
{
  "google-workspace": {
    "type": "streamable-http",
    "url": "http://host.containers.internal:8767/mcp"
  }
}
```

If Google Workspace MCP isn't set up on this machine, bots will still work — they just won't have Gmail/Calendar/Drive tools.

## 10. Pull State and Start

If syncing from an existing machine:
```bash
cd ~/2026-Nanoclaw/InfiniClaw
npm run cli sync pull    # Pull bot state from S3
npm run cli start        # Deploy and start all bots
```

If this is a fresh deployment (no existing state):
```bash
cd ~/2026-Nanoclaw/InfiniClaw
npm run cli start
```

## 11. Verify

```bash
cd ~/2026-Nanoclaw/InfiniClaw

# Check bot status
npm run cli status

# Check logs for errors
tail -20 _runtime/logs/cid.log
tail -20 _runtime/logs/johnny5.log
tail -20 _runtime/logs/albert.log

# Check containers are running
podman ps --filter name=nanoclaw

# Send a test message
npm run cli send bridge 'Hello from the new machine'
npm run cli send engineering '@cid status report'
```

Bots should appear online in Matrix within a minute.

## 12. Moving Bots Between Machines

To move a bot from Machine A to Machine B:

1. **Stop on A:**
   ```bash
   # On Machine A
   cd ~/2026-Nanoclaw/InfiniClaw
   npm run cli stop
   npm run cli sync push
   ```

2. **Update machine.json on both machines** — remove the bot from A's `bots` array, add to B's.

3. **Pull and start on B:**
   ```bash
   # On Machine B
   cd ~/2026-Nanoclaw/InfiniClaw
   npm run cli sync pull
   npm run cli start
   ```

4. **Restart remaining bots on A:**
   ```bash
   # On Machine A
   npm run cli start
   ```

## Troubleshooting

**Podman machine not running:**
```bash
podman machine start
```

**Container build fails with "no space":**
```bash
podman system prune -a
```

**Bot exits with code 137 (OOM):**
Session files grew too large. Clear them:
```bash
rm -f _runtime/instances/<bot>/store/sessions/*.jsonl
npm run cli start
```

**"Cannot connect to host.containers.internal":**
MCP proxies (WKSM/SCALEMAN) aren't running. Start them per step 9.

**Matrix login failures:**
Check `MATRIX_ACCESS_TOKEN` in the bot's env file. Tokens expire — regenerate via Matrix client if needed.
