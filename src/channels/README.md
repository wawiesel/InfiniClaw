# channels/ — Chat Transport Layer

Each channel implements the `Channel` interface from NanoClaw (`types.ts`). The host process connects to one or more channels and routes messages between them and the container pipeline.

- **matrix.ts** — The only channel. Connects to Matrix via `matrix-js-sdk`. Handles: message send/receive, editing, reactions, typing indicators, threads, rate limit retry with backoff, display name (CO badge), room-level read receipts, inbound mention pill restoration (`@` prefix), and outbound mention pill conversion via `<m>Name</m>` markers. `restoreMentionPrefixes` and `pillifyMentions` are exported for testing. See [01-matrix](../../docs/design/01-matrix.md) for the mention pill symmetry and special mentions spec.
