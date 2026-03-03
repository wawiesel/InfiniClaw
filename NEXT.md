# NEXT — Issues to Fix

## ~~`cli stop` removes non-bot launchd plists~~ FIXED (26eed38)

## ~~`cli send` still injects into local DB~~ FIXED (61c9412, deployed)

## ~~Cid's S3 config key mismatch~~ RESOLVED

Convention: `accessKey`/`secretKey` in machine.json, mapped to AWS SDK names in `s3-sync.ts`. SETUP.md updated to match.

## ~~Architect bot not starting~~ FIXED

Was caused by missing `agent-runner/src` mount path (fixed in 9ad2f75 — `mountIfExists` guard).

## ~~Private homeserver simplifications~~ DONE

Now that the fleet runs on `matrix.a-gis.org` (Continuwuity) instead of matrix.org, several defensive workarounds have been removed:

- ~~**m.replace event filtering**~~ — Kept intentionally: bots should never react to edits regardless of server. `STATUS_INDICATOR_RE` in `message-filtering.ts` correctly filters initial status indicator sends. No change needed.
- ~~**Rate limit retry/backoff logic**~~ — **Removed** (c59b11c). Stripped `M_LIMIT_EXCEEDED` handling, adaptive backoff, 1s inter-message delay, and all retry state. `enqueueSend` is now a simple sequential queue.
- ~~**Corporate CA cert for Matrix**~~ — Private homeserver uses Let's Encrypt (no custom CA needed). `BRAIN_CA_CERT_FILE` → `NODE_EXTRA_CA_CERTS` mapping kept for Anthropic API (may go through corporate proxy). No change needed.
- ~~**`send` CLI DB injection**~~ — Already removed (61c9412). `buildRoomMap` rank-based selection kept for CO election, which is still correct.
- ~~**Sync token / filter complexity**~~ — No complex filter management found; `matrix-bot-sdk` handles sync internally. `syncingPresence = 'offline'` kept (reduces unnecessary traffic). No change needed.

## Navigator (Nora) responsiveness problems

- Nora takes too long to respond — Opus on mac139160 is slow, and long sessions compound the latency.
- ~~OOM kills (exit 137) — 12GB container memory limit hit repeatedly.~~ Increased to 16GB.
- ~~Stale Matrix sync — Nora stops receiving messages after hours of running.~~ Improved with MCP preflight (no more startup hangs on broken MCP).
- ~~Session loss on restart~~ Fixed with session recovery in agent-runner.
- Thread routing: auto-thread is implemented (1c30fdd) but Nora still needs to manage thread-to-topic mapping in her memory so she returns to the right thread for ongoing work.
