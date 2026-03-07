# BUGS — Known Issues

When this file has content, the commanding engineer must address these items first, delegating and using threads as appropriate.

## Active Bugs

### 5. `_runtime/staging/` contains stale code with removed features

**Directory:** `_runtime/staging/*/src/main.ts`

Staging copies still have standing orders, status indicators, run-progress nudge, and PIP_PULSE code. These will be deployed into containers until bots are rebuilt.

**Fix:** Rebuild and redeploy affected bots (`!refit` or `!restart`).
