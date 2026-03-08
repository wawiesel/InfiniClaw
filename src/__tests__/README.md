# InfiniClaw `src/__tests__/` — What Goes Here

Integration and unit tests for InfiniClaw source modules that don't live next to their source file.

**Naming convention:** `<module>.test.ts` mirrors `src/<module>.ts`.

## What belongs here

- Tests that span multiple modules or require complex setup
- Tests for modules where co-location (e.g. `foo.test.ts` next to `foo.ts`) isn't practical

## What does NOT belong here

- Co-located tests that live next to their source file (`src/foo.test.ts`)
- nanoclaw tests → `external/nanoclaw/src/*.test.ts`

## Current tests

| File | Tests |
|------|-------|
| `command-registry.test.ts` | Validates `COMMANDS` array registration |
| `ipc-auth.test.ts` | IPC auth boundary checks |
| `matrix-format.test.ts` | Matrix HTML formatting correctness |
| `operator-commands.test.ts` | `!` command parsing and auth |
| `routing.test.ts` | Message routing logic |

Run with: `npx vitest run --root .`
