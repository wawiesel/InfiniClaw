FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install claude CLI
RUN npm install -g @anthropic-ai/claude-code --ignore-scripts

WORKDIR /app

ENTRYPOINT ["claude"]
