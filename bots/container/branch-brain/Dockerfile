FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install claude CLI
RUN npm install -g @anthropic-ai/claude-code

# claude CLI refuses --dangerously-skip-permissions as root
RUN useradd -m -s /bin/bash claude

# Pre-create session-env with correct ownership — npm install above creates
# /home/claude/.claude as root, causing EACCES in the agent SDK's Bash sandbox.
RUN mkdir -p /home/claude/.claude/session-env && \
    chown -R claude:claude /home/claude/.claude

USER claude
WORKDIR /home/claude

ENTRYPOINT ["claude"]
