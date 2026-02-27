#!/bin/bash
# Start SCALEMAN MCP as SSE proxy on port 8766
# Mirrors the WKSM proxy pattern (port 8765) but for SCALEMAN.
set -euo pipefail

SCALEMAN_VENV="${HOME}/2026-SCALEMAN/scaleman/venv"
SCALEMAN_INDEX="${HOME}/2026-SCALEMAN/scaleman-index"
PORT=8766

export SCALEMAN_URI="file://${SCALEMAN_INDEX}"

# Kill any existing process on this port
/usr/sbin/lsof -ti:"$PORT" | xargs kill -9 2>/dev/null || true
sleep 1

# Start the SSE proxy wrapping SCALEMAN's stdio MCP server
nohup npx -y supergateway \
  --port "$PORT" \
  --healthEndpoint /health \
  --stdio "${SCALEMAN_VENV}/bin/python -m scaleman.mcp.server" \
  > /tmp/scaleman-proxy.log 2>&1 &

echo "SCALEMAN proxy started on port $PORT (pid $!)"
