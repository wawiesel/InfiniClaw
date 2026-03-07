# 12 — Deployment Chain

Engineers work on git worktrees, never on main. Code does not merge to main until it passes a full deployment chain that proves it works end-to-end in a self-contained simulation.

## Worktree Workflow

1. Engineer creates a feature branch and worktree (`git worktree add`)
2. All development happens in the worktree — main stays clean
3. When the engineer believes the work is ready, they submit it to the deployment chain
4. Only after the chain passes does the branch merge to main

## Deployment Chain

The deployment chain is a gated sequence. Each stage must pass before the next begins.

### Stage 1: Build

Compile the worktree. If `tsc` or `npm run build` fails, stop.

### Stage 2: Test

Run the test suite (`npm test`). If any test fails, stop.

### Stage 3: Holodeck Simulation

This is the core gate. A fully self-contained InfiniClaw instance runs inside a container, simulating a complete ship with a fake crew.

#### Holodeck ship setup

- A temporary "ship" is created with its own:
  - InfiniClaw instance (from the feature branch worktree)
  - Secrets repo (synthetic — fake credentials, fleet.json, env files)
  - Matrix rooms (or a mock Matrix layer)
  - S3 bucket (or mock)
- The ship runs three bots:
  - **Fake engineer** — acts as Captain and Operator, runs the crew through exercises
  - **Fake navigator** — tests navigation/research workflows
  - **Fake architect** — tests holodeck/testing workflows
- All three use the feature branch code, not main

#### Exercises

The fake engineer (acting as Captain) runs the crew through scenarios that exercise the changed code paths. At minimum:

- Bot startup and Matrix connection
- Message routing (direct mention, thread participation, CO duty)
- IPC commands (restart, health check, fleet status)
- Any feature-specific scenarios relevant to the branch

The fake engineer declares the simulation passed or failed based on observed behavior.

#### Isolation

The holodeck ship is completely isolated:
- No access to production Matrix rooms
- No access to production secrets
- No access to production S3
- Cannot affect running bots or the relay

### Stage 4: Merge

If the holodeck simulation passes:
1. Rebase the feature branch onto current main
2. Merge to main (fast-forward preferred)
3. Push
4. The relay auto-sync picks up the new code and deploys via normal refit

## Why

Engineers currently push directly to main. A bad commit breaks all ships simultaneously — there is no staging environment. The deployment chain creates a gate where code proves itself before it can affect production. The holodeck simulation catches integration bugs that unit tests miss: message routing, IPC flow, container lifecycle, multi-bot interactions.
