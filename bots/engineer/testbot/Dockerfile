# NanoClaw TestBot Agent Container
# Minimal test bot for IC01 staging fleet.

FROM node:22-slim

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

RUN pip3 install --break-system-packages click matplotlib scipy numpy pydantic claude-code-tools

ENV NODE_OPTIONS="--max-old-space-size=1024"

RUN npm install -g npm@latest
RUN npm install -g @anthropic-ai/claude-code @google/gemini-cli @openai/codex

WORKDIR /app
COPY agent-runner/package*.json ./
RUN npm install
COPY agent-runner/ ./
RUN npm run build

RUN mkdir -p /workspace/persona/temp /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

RUN printf '#!/bin/bash\nset -e\ncat > /tmp/input.json\nnode /app/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

RUN chown -R node:node /workspace
RUN mkdir -p /home/claude/.claude && chown -R node:node /home/claude
USER node
RUN git config --global --add safe.directory '*'

WORKDIR /workspace/persona/temp
ENTRYPOINT ["/app/entrypoint.sh"]
