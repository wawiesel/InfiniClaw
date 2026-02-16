# NanoClaw Engineer Agent Container
# Lean image for Cid — infrastructure and code operations only.
# No browser, no heavy dev tools. Just git, ripgrep, and Claude Code.

FROM node:22-slim

# Minimal system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    git \
    ripgrep \
    python3 \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Install global CLIs used by delegates/runners
RUN npm install -g @anthropic-ai/claude-code @google/gemini-cli @openai/codex

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Patch SDK for runtime backend detection:
# 1. countTokensWithFallback returns null when NANOCLAW_SKIP_TOKEN_COUNTING=1
# 2. Context window reads from NANOCLAW_CONTEXT_WINDOW env (default 200K for Claude)
RUN node -e " \
  const fs = require('fs'); \
  const p = '/app/node_modules/@anthropic-ai/claude-agent-sdk/cli.js'; \
  let c = fs.readFileSync(p, 'utf8'); \
  let patches = 0; \
  /* Patch 1: conditional countTokensWithFallback bypass */ \
  const marker = 'countTokensWithFallback: API returned null'; \
  const idx = c.indexOf(marker); \
  if (idx === -1) { console.error('marker not found'); process.exit(1); } \
  const fnStart = c.lastIndexOf('async function', idx); \
  const braceIdx = c.indexOf('{', fnStart); \
  c = c.slice(0, braceIdx + 1) + 'if(process.env.NANOCLAW_SKIP_TOKEN_COUNTING===\"1\")return null;' + c.slice(braceIdx + 1); \
  patches++; \
  /* Patch 2: runtime-configurable context window */ \
  c = c.replace(/vhq=200000/g, 'vhq=parseInt(process.env.NANOCLAW_CONTEXT_WINDOW||\"200000\")'); \
  patches++; \
  fs.writeFileSync(p, c); \
  console.log('SDK patched (' + patches + ' patches applied)'); \
"

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
RUN printf '#!/bin/bash\nset -e\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace

# Switch to non-root user
USER node

WORKDIR /workspace/group

ENTRYPOINT ["/app/entrypoint.sh"]
