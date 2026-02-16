# NanoClaw Commander Agent Container
# Full-featured image for J5 — task execution, data analysis, development.
# This image grows over time as Cid observes what J5 needs.

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
RUN pip3 install --break-system-packages docling rapidocr-onnxruntime pymupdf

# Fix model directory permissions for node user
RUN chmod -R 777 /usr/local/lib/python3.11/dist-packages/rapidocr/models/ || true

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

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
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
RUN printf '#!/bin/bash\nset -e\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace

# Switch to non-root user
USER node

WORKDIR /workspace/group

ENTRYPOINT ["/app/entrypoint.sh"]
