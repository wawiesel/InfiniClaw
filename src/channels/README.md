# channels/ — Chat Transport Layer

Each channel implements the `Channel` interface from NanoClaw (`types.ts`). The host process connects to one or more channels and routes messages between them and the container pipeline.

- **matrix.ts** — The only channel. Connects to Matrix via `matrix-js-sdk`. Handles: message send/receive, editing, reactions, typing indicators, threads, rate limit retry with backoff, display name (CO badge), room-level read receipts, inbound mention pill wrapping (`<m>Name</m>` markers), raw `@Name` → `<m>` conversion via display-name cache, and outbound mention pill conversion via `<m>Name</m>` markers. `restoreMentionPrefixes`, `pillifyMentions`, and `convertRawMentions` are exported for testing. `botUserId` is exported for relay access. See [01-matrix](../../docs/design/01-matrix.md) for the mention pill symmetry, reactions, and special mentions spec.
