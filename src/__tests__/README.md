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
| `matrix-mentions.test.ts` | Mention pill symmetry: inbound `<m>` wrapping (handles bare `Name` and `@name` from pills, case-insensitive), outbound `<m>` → pill conversion, raw `@Name` → `<m>` conversion (display names use realistic pip-prefix format) |
| `operator-commands.test.ts` | `!` command parsing and auth |
| `routing.test.ts` | Message routing logic |
| `metrics.test.ts` | Fleet metrics: rollingRate, SCORE_REACTIONS, operator/bot/ship/fleet metrics, autonomy score (x-commands excluded), infra failure tracking, branch brain success, tokenThroughput rolling metric, response latency tracking, MTBI in operator metrics, scope routing, formatting, health grades (A/B/C/F from crashes/OOM/mem/latency), fleet aggregate grade, activity icons (tok/day tiers), gradeEmoji mapping, score attribution per bot (empty name vs named), latency/throughput in BotMetrics types. |
| `wbs.test.ts` | WBS lifecycle: assign, reabsorb, completeItem (dependency unblocking), autoAssign, nextReadyItem priority ordering, wbsToTodos conversion (16 tests). |

Run with: `npx vitest run --root .`
