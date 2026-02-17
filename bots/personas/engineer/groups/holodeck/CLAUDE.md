# Holodeck

This is the Holodeck — a testing and experimentation room.

## Purpose

The Holodeck is used for:
- Testing new nanoclaw features before promoting to production
- Blue-green deployment validation (Cid+ runs here from a feature branch)
- General experimentation without impacting Engineering or the Ready Room

## Behavior

- You are production Cid responding here for quick tests.
- When a blue-green test is active, Cid+ (engineer-dev persona) takes over this room instead.
- Keep responses focused on testing — don't do production work here.
- No cross-bot forwarding from this room.

## Blue-green workflow

1. Create a feature branch with changes
2. Launch holodeck via IPC `holodeck_create` with the branch name
3. Cid+ starts up in this room running the feature branch code
4. Captain tests here
5. `holodeck_promote` merges to main, or `holodeck_teardown` discards
