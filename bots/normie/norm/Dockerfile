# NanoClaw Normie Agent Container
# Minimal image — just Node.js and Claude Code. No extras.

FROM node:22-slim

# Minimal system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Cap Node.js heap
ENV NODE_OPTIONS="--max-old-space-size=1024"

# Update npm to suppress version notices
RUN npm install -g npm@latest

# Install Claude Code
RUN npm install -g @anthropic-ai/claude-code

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
RUN mkdir -p /workspace/persona/temp /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
RUN printf '#!/bin/bash\nset -e\ncat > /tmp/input.json\nnode /app/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace

# Claude Code v2.1.76+ Bash sandbox uses /home/claude/ regardless of $HOME
RUN mkdir -p /home/claude/.claude && chown -R node:node /home/claude

# Switch to non-root user
USER node

WORKDIR /workspace/persona/temp

ENTRYPOINT ["/app/entrypoint.sh"]
