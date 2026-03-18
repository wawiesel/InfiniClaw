# NanoClaw Parker Agent Container
# Lean image for Parker — health monitoring and system engineering.
# No browser, no heavy dev tools. Just git, ripgrep, and Claude Code.

FROM node:22-slim

# Minimal system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    gh \
    git \
    ripgrep \
    tmux \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Install A_GIS dependencies so the runtime mount is immediately usable.
# Also install claude-code-tools to provide tmux-cli in engineer containers.
# PYTHONPATH is injected at runtime via CONTAINER_ENV_PYTHONPATH in the bot's profile env.
RUN pip3 install --break-system-packages click matplotlib scipy numpy pydantic claude-code-tools

# Cap Node.js heap so processes GC instead of growing until VM OOM.
# Applies to main brain, MCP server, and lobe spawns.
ENV NODE_OPTIONS="--max-old-space-size=1024"

# Update npm to suppress version notices
RUN npm install -g npm@latest

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
RUN mkdir -p /workspace/persona/temp /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
# TypeScript is pre-compiled during image build (npm run build → /app/dist).
# At spawn time we just read stdin and run the pre-built JS — no tsc overhead.
RUN printf '#!/bin/bash\nset -e\ncat > /tmp/input.json\nnode /app/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace

# Claude Code v2.1.76+ Bash sandbox uses /home/claude/ regardless of $HOME
RUN mkdir -p /home/claude/.claude && chown -R node:node /home/claude

# Switch to non-root user
USER node

# Allow git operations on mounted repos (host UID may differ from container UID)
RUN git config --global --add safe.directory '*'

WORKDIR /workspace/persona/temp

ENTRYPOINT ["/app/entrypoint.sh"]
