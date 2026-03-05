# 05 — Commanding Officer

Each room has a **commanding officer (CO)** — the lowest-rank active bot on that room. The CO:
- Gets a star badge in their Matrix display name (e.g. "BotName ⭐")
- All bots require @callout — CO designation is for rank/authority and display badge only

CO is determined from `crew-status.json` at startup and updated at runtime via supervisor lifecycle messages. Display name badges: ⭐ = CO, 🟢 = active, 🔴 = dismissed/offline.

## Startup

Each bot reads `crew-status.json` (generated at deploy from fleet-wide presence) to set its initial badge. The CO determination happens BEFORE the Matrix connection so the initial display name is correct (avoids a badge race where connect sets 🟢 then CO logic overwrites with ⭐).

## Runtime Updates

When the supervisor dismisses/joins a bot, it posts a lifecycle message to the room via intercom (e.g. `HERACLES: Cid stopped`). All bots in the room parse these messages to update their in-memory roster and re-evaluate CO. The supervisor also updates the local presence file so future deploys generate correct `crew-status.json`.

## Querying

Bots query the live roster via the `crew_roster` MCP tool, which reads `crew-status.json`.
