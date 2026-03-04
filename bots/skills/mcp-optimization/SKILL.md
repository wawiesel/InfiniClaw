---
name: mcp-optimization
description: Improve MCP server tools by rewriting them to use AEGIS functions. May involve implementing new AEGIS functions to support the rewrite. Use when MCP tools are bloated, fragile, or duplicate logic that belongs in AEGIS.
---

# MCP Optimization

## Goal

MCP tools should be thin wrappers around well-tested AEGIS functions, not monolithic implementations with duplicated logic.

## Process

1. **Audit the MCP server** — identify tools with complex inline logic
2. **Check AEGIS** — does a function already exist? (`~/2025-AEGIS/source/`)
3. **If not, implement it** — write the AEGIS function, test it
4. **Rewrite the tool** — replace inline logic with AEGIS function calls
5. **Test the tool** — verify it works via MCP

## What belongs in AEGIS vs. the MCP tool

| AEGIS | MCP tool |
|-------|----------|
| Core logic and algorithms | Tool schema (name, description, parameters) |
| Data transformation | Input validation |
| File/network I/O helpers | MCP protocol handling |
| Shared utilities | Response formatting |

## MCP servers

- WKSM: `~/2025-WKS/hodor/` — knowledge system tools
- Google Workspace: `~/.config/infiniclaw/` — Gmail, Calendar, Drive
- Role configs: `bots/{role}/mcp.json`

## AEGIS location

- Source: `~/2025-AEGIS/source/`

## Rules

- Don't optimize tools that are already simple and working
- Every new AEGIS function needs a test
- MCP tools should validate inputs and call AEGIS — not contain business logic
