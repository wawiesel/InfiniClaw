# Branch Brain container — uses the same agent-runner entrypoint as main brains.
# Lighter than full bot images (no python, ripgrep, etc.) but same spawn protocol:
# stdin JSON → agent-runner → claude subprocess with env-injected credentials.

FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates gh \
    && rm -rf /var/lib/apt/lists/*

# Install claude CLI
RUN npm install -g @anthropic-ai/claude-code

# Create app directory
WORKDIR /app

# Copy agent-runner package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy agent-runner source
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/persona/temp /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script — same as main brain containers:
# reads stdin JSON, runs pre-built agent-runner JS
RUN printf '#!/bin/bash\nset -e\ncat > /tmp/input.json\nnode /app/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace

# Claude Code Bash sandbox uses /home/claude/ regardless of $HOME
RUN mkdir -p /home/claude/.claude && chown -R node:node /home/claude

# Switch to non-root user
USER node

# Allow git operations on mounted repos (host UID may differ from container UID)
RUN git config --global --add safe.directory '*'

WORKDIR /workspace/persona/temp

ENTRYPOINT ["/app/entrypoint.sh"]
