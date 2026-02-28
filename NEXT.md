# NEXT — Issues to Fix

## ~~`cli stop` removes non-bot launchd plists~~ FIXED (26eed38)

## ~~`cli send` still injects into local DB~~ FIXED (61c9412, deployed)

## ~~Cid's S3 config key mismatch~~ RESOLVED

Convention: `accessKey`/`secretKey` in machine.json, mapped to AWS SDK names in `s3-sync.ts`. SETUP.md updated to match.

## ~~Architect bot not starting~~ FIXED

Was caused by missing `agent-runner/src` mount path (fixed in 9ad2f75 — `mountIfExists` guard).
