# 03 — IPC

Container ↔ host communication. Containers write JSON commands to `/workspace/ipc/output/`, and `ipc-watcher.ts` on the host polls the directory and processes them.

## Per-Room Namespaces

Each room gets its own IPC directory (`_runtime/data/ipc/{room}/`). Prevents cross-room privilege escalation.

## Main Room Elevation

Only the main room's containers can run privileged IPC commands (`refresh_bot`, `rebuild_image`, `git_push`). Other rooms are restricted to task scheduling and thread management.

## Cooldowns

IPC commands have per-command cooldowns to prevent bots from spamming expensive operations (e.g. rapid restarts).

## Restart Cooldown

60-second cooldown enforced between restarts of the same bot via IPC. Prevents bots from burning context in rapid restart cycles.
