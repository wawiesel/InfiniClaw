# NEXT — Issues to Fix

## ~~`cli stop` removes non-bot launchd plists~~ FIXED (26eed38)

## ~~`cli send` still injects into local DB~~ FIXED (61c9412, deployed)

## ~~Cid's S3 config key mismatch~~ RESOLVED

Convention: `accessKey`/`secretKey` in machine.json, mapped to AWS SDK names in `s3-sync.ts`. SETUP.md updated to match.

## ~~Architect bot not starting~~ FIXED

Was caused by missing `agent-runner/src` mount path (fixed in 9ad2f75 — `mountIfExists` guard).

## Navigator (Nora) responsiveness problems

- Nora takes too long to respond — Opus on mac139160 is slow, and long sessions compound the latency.
- OOM kills (exit 137) — 12GB container memory limit hit repeatedly. May need to increase `CONTAINER_MEMORY_MB` or rotate sessions more aggressively.
- Stale Matrix sync — Nora stops receiving messages after hours of running. Requires restart to recover.
- Thread routing: auto-thread is implemented (1c30fdd) but Nora still needs to manage thread-to-topic mapping in her memory so she returns to the right thread for ongoing work.
