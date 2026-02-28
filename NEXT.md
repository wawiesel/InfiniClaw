# NEXT — Issues to Fix

## ~~`cli stop` removes non-bot launchd plists~~ FIXED (26eed38)

## ~~`cli send` still injects into local DB~~ FIXED (61c9412, deployed)

## ~~Cid's S3 config key mismatch~~ FIXED

Standardized on AWS-standard names (`accessKeyId`/`secretAccessKey`) across `machine-config.ts`, `s3-sync.ts`, and `machine.json`.

## ~~Architect bot not starting~~ FIXED

Was caused by missing `agent-runner/src` mount path (fixed in 9ad2f75 — `mountIfExists` guard).
