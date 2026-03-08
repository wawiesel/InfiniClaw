# nanoclaw `src/channels/` — What Goes Here

This directory is the **channel plugin registry**: the framework for adding new communication backends to nanoclaw. Each channel connects nanoclaw to a messaging platform (Matrix, Discord, Telegram, etc.).

**Owner:** Albert (nanoclaw upstream). Cid does minor maintenance only.

## What belongs here

- `registry.ts` — Channel factory registry: `registerChannel()`, `getChannelFactory()`, `getRegisteredChannelNames()`
- `index.ts` — Self-registration barrel: importing this file triggers all channel modules to call `registerChannel()`
- Per-channel implementations (currently none are active — stubs only)

## What does NOT belong here

- Host-side Matrix client code → `../../src/channels/matrix.ts` (InfiniClaw)
- Channel-agnostic message routing → `../group-queue.ts`, `../composables.ts`
- Bot container orchestration → `../container-runner.ts`

## How channels work

1. A channel module calls `registerChannel(name, factory)` on import
2. `index.ts` imports all channel modules (self-registration pattern)
3. At runtime, `getChannelFactory(name)` retrieves the factory for a given channel type
4. The factory receives `{ onMessage, onChatMetadata, registeredGroups }` callbacks and returns a `Channel` instance

## Engineer observations (updated 2026-03-08)

- No channel implementations are currently active in this directory — Matrix is implemented directly in InfiniClaw (`src/channels/matrix.ts`), not via this registry.
- The registry pattern is designed for future multi-channel support (Discord, Telegram, etc.) without modifying core nanoclaw code.
