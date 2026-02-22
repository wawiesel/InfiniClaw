---
name: wksm-setup-and-diagnosis
description: Instructions for setting up, diagnosing, and fixing the WKSM (WKS MCP Server) for any bot inside their container.
---

# WKSM Setup and Diagnosis

As the Engineer, you are responsible for making sure the WKSM (Wieselquist Knowledge System MCP Server) is operational for the bots (primarily the Commander in the Bridge).

## Container Setup for WKSM

A bot's container is configured for WKSM via its `container-config.json` (e.g., `bots/personas/commander/container-config.json`).
An active setup must include two things:

1. **The MCP Server Entry**:
   ```json
   "mcpServers": {
     "wksm": {
       "command": "python3",
       "args": ["-m", "wks.mcp.main"],
       "env": {
         "PYTHONPATH": "/workspace/extra/home/2025-WKS/main"
       },
       "cwd": "/workspace/extra/home/2025-WKS/main"
     }
   }
   ```
2. **The Required Mount**:
   The bot must have a mount for the home directory to access the codebase.
   ```json
   "additionalMounts": [
     {
       "hostPath": "~",
       "containerPath": "home",
       "readonly": true
     }
   ]
   ```

*Note: The WKS repo is located at `~/2025-WKS/main` on the host, which maps to `/workspace/extra/home/2025-WKS/main` in the container.*

## Diagnosis & Troubleshooting

If WKSM is failing to start, failing to build, or returning errors, you must diagnose the issue in the codebase itself. 

1. **Verify the container config**: Ensure the `cwd` and `PYTHONPATH` in the `mcpServers` block accurately points to `/workspace/extra/home/2025-WKS/main`.
2. **Check Logs**: Review the bot logs at `$INFINICLAW_ROOT/_runtime/logs/{bot}.log` and `$INFINICLAW_ROOT/_runtime/logs/{bot}.error.log` to see if Python threw an error initializing the MCP server or importing dependencies.
3. **Inspect the Code**: Navigate to `/workspace/extra/home/2025-WKS/main` and inspect the source code, `pyproject.toml`, or the specific `wks.mcp.main` module. Run manual python tests if necessary.

## Fixing WKSM & Requesting Read/Write Upgrades

Because your `~` mount is `readonly: true` by default, you **cannot** write fixes, run `npm install`, or `npm run build` directly in the `~/2025-WKS/main` repo if a code fix is required.

If you determine that WKSM requires a development fix or a rebuild, you MUST:

1. Request a **mount upgrade** from the Captain (William).
2. Ask the Captain to run: `!grant-mount ~/2025-WKS/main` (or a specific subdirectory).
3. Wait for the Captain to confirm the grant and automatically restart your container.
4. Once restarted, verify you have write access to the repo.
5. Develop the fix, build the new `dist/index.js`, and test internally. 
6. Request the Captain to revoke the mount when you are finished by using `!revoke-mount ~/2025-WKS/main`.
