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
| `ipc-auth.test.ts` | IPC auth boundary checks (includes sendReaction mock) |
| `matrix-format.test.ts` | Matrix HTML formatting correctness |
| `matrix-mentions.test.ts` | Mention pill symmetry: inbound `<m>` wrapping, outbound `<m>` → pill conversion, raw `@Name` → `<m>` conversion |
| `operator-commands.test.ts` | `!` command parsing and auth |
| `routing.test.ts` | Message routing logic |
| `metrics.test.ts` | Fleet metrics: rollingRate, SCORE_REACTIONS, operator/bot/ship/fleet metrics, autonomy score (x-commands excluded), infra failure tracking, branch brain success, scope routing (bot-scoped returns empty on non-owning ships), formatting per `docs/design/20-metrics.md` — badges ◉ (running), 🔴 (down), 💤 (sleep) (46 tests). `relayRestarts` is `RollingMetric` (1d/7d), not cumulative. |

Run with: `npx vitest run --root .`
