# channels/ — Chat Transport Layer

Each channel implements the `Channel` interface from NanoClaw (`types.ts`). The host process connects to one or more channels and routes messages between them and the container pipeline.

- **matrix.ts** — Primary channel. Connects to Matrix via `matrix-js-sdk`. Handles: message send/receive, editing, reactions, typing indicators, threads, rate limit retry with backoff, display name (CO badge), and room-level read receipts.

- **local-cli.ts** — Terminal channel for `npm run cli chat <bot>`. Direct stdin/stdout conversation with a single bot, no Matrix involved.
