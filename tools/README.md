# InfiniClaw Tools

Standalone utilities for host-side use. No compilation required.

## history-mcp-server.cjs

MCP server that reads conversation history from S3.

**Requires**: S3 configured in `~/.config/infiniclaw/machine.json`

**Add to your `~/.claude/claude_desktop_config.json` or `.mcp.json`:**
```json
{
  "mcpServers": {
    "history": {
      "command": "node",
      "args": ["/path/to/InfiniClaw/tools/history-mcp-server.cjs"]
    }
  }
}
```

**Tools:**
- `list_history(room?, date?)` — list available JSONL files in S3
- `get_history(room, date?, limit?)` — read messages from S3

**S3 key format:** `history/{room-slug}/{YYYY-MM-DD}/{HH-MM-SS}.jsonl`

History is exported every 15 minutes by each running bot. S3 lifecycle rules
can be configured to delete files older than 7 days using the `history/` prefix.
