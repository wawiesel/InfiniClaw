# NanoClaw Engineer Agent Container
# Lean image for Cid — infrastructure and code operations only.
# No browser, no heavy dev tools. Just git, ripgrep, and Claude Code.

FROM node:22-slim

# Minimal system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    git \
    ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Install global CLIs used by delegates/runners
RUN npm install -g @anthropic-ai/claude-code @google/gemini-cli @openai/codex

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

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
