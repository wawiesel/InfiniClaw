# 18 — Deployment Chain

Engineers and architects work on git worktrees, never on main. Code does not merge to main until it passes a full deployment chain that proves it works end-to-end in a self-contained simulation.

## Who Uses This

- **Engineers** use the simulation platform to develop and test changes to InfiniClaw and Nanoclaw (the bot framework itself).
- **Architects** use the simulation platform to develop and test changes to AEGIS and InfiniClaw, including the design refactor of MCP tools and skill scripts into AEGIS.

Both roles follow the same deployment chain. The only difference is what they're changing.

## Worktree Workflow

1. Create a feature branch and worktree (`git worktree add`)
2. All development happens in the worktree — main stays clean
3. When the work is ready, submit it to the deployment chain
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
  - **Simulated engineer** — tests engineering workflows
  - **Simulated navigator** — tests navigation/research workflows
  - **Simulated architect** — tests holodeck/testing workflows
- All three use the feature branch code, not main
- The **real bot** (the engineer or architect who developed the feature) acts as Captain and Operator of the holodeck ship

#### Exercises

The real bot who developed the changes acts as Captain and Operator of the simulated ship. They run the crew through scenarios that exercise the changed code paths. At minimum:

- Bot startup and Matrix connection
- Message routing (direct mention, thread participation, CO duty)
- IPC commands (restart, health check, fleet status)
- Any feature-specific scenarios relevant to the branch

The developing bot declares the simulation passed or failed based on observed behavior. The simulation is not a scripted test — the bot uses judgment, just like a real Captain would.

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

Engineers and architects currently push directly to main. A bad commit breaks all ships simultaneously — there is no staging environment. The deployment chain creates a gate where code proves itself before it can affect production. The holodeck simulation catches integration bugs that unit tests miss: message routing, IPC flow, container lifecycle, multi-bot interactions.

This was motivated by a real incident: an engineer's Phase 1 branch/merge commit added `onMergeRequest` to `IpcDeps` without updating test mocks or all call sites, breaking the build on main for every ship.

## Verification

1. **Build gate** — Submit code that fails `tsc`.
   *Check:* Chain stops at Stage 1 with build error.

2. **Test gate** — Submit code that fails a test.
   *Check:* Chain stops at Stage 2 with test failure.

3. **Holodeck creates** — Trigger holodeck simulation.
   *Check:* Isolated ship with fake crew starts, runs exercises.

4. **Holodeck isolation** — Verify holodeck cannot reach production.
   *Check:* No access to production Matrix, secrets, or S3.

5. **Merge after pass** — Holodeck simulation passes.
   *Check:* Branch merged to main, relay auto-deploys via refit.
