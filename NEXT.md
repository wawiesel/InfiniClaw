# NEXT — Issues to Fix

## ~~`cli stop` removes non-bot launchd plists~~ FIXED (26eed38)

## ~~`cli send` still injects into local DB~~ FIXED (61c9412, deployed)

## ~~Cid's S3 config key mismatch~~ RESOLVED

Convention: `accessKey`/`secretKey` in machine.json, mapped to AWS SDK names in `s3-sync.ts`. SETUP.md updated to match.

## ~~Architect bot not starting~~ FIXED

Was caused by missing `agent-runner/src` mount path (fixed in 9ad2f75 — `mountIfExists` guard).

## Private homeserver simplifications

Now that the fleet runs on `matrix.a-gis.org` (Continuwuity) instead of matrix.org, several defensive workarounds can be removed:

- **m.replace event filtering** (`src/channels/matrix.ts` ~line 857, `src/message-filtering.ts` STATUS_INDICATOR_RE) — the feedback loop was caused by matrix.org latency amplifying edit events. On a private server with no rate limits, status indicator edits are harmless. Consider removing the filter or rethinking status indicators entirely.
- **Rate limit retry/backoff logic** — any `M_LIMIT_EXCEEDED` handling or retry-after delays in the Matrix client layer are unnecessary on a private server with 6 users.
- **Corporate CA cert for Matrix** (`BRAIN_CA_CERT_FILE` referenced in env files) — the private homeserver uses a public Let's Encrypt cert via the Synology NAS reverse proxy, so no custom CA bundle is needed for Matrix connections. May still be needed for the Anthropic API if that goes through corporate proxy.
- **`send` CLI DB injection** — already removed; send now goes through Matrix only. But the old `buildRoomMap` rank-based bot selection is still used elsewhere and could be simplified since the room topology is now self-contained on the private server.
- **Sync token / filter complexity** — matrix.org required careful sync filter management to avoid hitting rate limits. Private server can use simpler, more aggressive sync settings.

## Navigator (Nora) responsiveness problems

- Nora takes too long to respond — Opus on mac139160 is slow, and long sessions compound the latency.
- ~~OOM kills (exit 137) — 12GB container memory limit hit repeatedly.~~ Increased to 16GB.
- ~~Stale Matrix sync — Nora stops receiving messages after hours of running.~~ Improved with MCP preflight (no more startup hangs on broken MCP).
- ~~Session loss on restart~~ Fixed with session recovery in agent-runner.
- Thread routing: auto-thread is implemented (1c30fdd) but Nora still needs to manage thread-to-topic mapping in her memory so she returns to the right thread for ongoing work.
