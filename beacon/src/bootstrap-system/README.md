# `bootstrapSystem`

Coordinates the beacon bootstrap flow:

- validate input
- update `systems.json`
- write local beacon state
- emit the relay start command

This is the core phase-1 beacon capability.
