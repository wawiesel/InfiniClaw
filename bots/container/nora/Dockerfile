# NanoClaw Navigator Agent Container
# Same image as Commander — task execution, data analysis, development.
# Navigator (Nora) handles planning, scheduling, email, calendar, coordination.

FROM node:22-slim

# System dependencies: browser, dev tools, data tools
RUN apt-get update && apt-get install -y \
    ca-certificates \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    ripgrep \
    jq \
    wget \
    unzip \
    build-essential \
    python3 \
    python3-pip \
    python3-venv \
    tesseract-ocr \
    tesseract-ocr-eng \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install docling for PDF-to-markdown conversion (includes OCR via pytesseract/easyocr)
# workspace-mcp: Google Workspace (Gmail, Calendar, Drive) MCP server
RUN pip3 install --break-system-packages \
    docling rapidocr-onnxruntime pymupdf workspace-mcp \
    click matplotlib scipy numpy pydantic

# PYTHONPATH is injected at runtime via CONTAINER_ENV_PYTHONPATH in the bot's profile env.

# Fix model directory permissions for node user
RUN chmod -R 777 /usr/local/lib/python3.11/dist-packages/rapidocr/models/ || true

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Cap Node.js heap so processes GC instead of growing until VM OOM.
# Applies to main brain, MCP server, and lobe spawns.
ENV NODE_OPTIONS="--max-old-space-size=8192"

# Update npm to suppress version notices
RUN npm install -g npm@latest

# Install global CLIs used by delegates/runners
RUN npm install -g agent-browser @anthropic-ai/claude-code @google/gemini-cli @openai/codex

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

# Switch to non-root user
USER node

WORKDIR /workspace/persona/temp

ENTRYPOINT ["/app/entrypoint.sh"]
