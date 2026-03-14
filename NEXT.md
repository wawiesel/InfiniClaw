# NEXT — InfiniClaw Task Queue

Prioritized by Captain value. Top items are most urgent / highest signal. Bots: check this list, pick the top unblocked item, and work on it. Operator: review and reprioritize as the fleet evolves.

Last curated: 2026-03-14 19:18 (Branch Brain monitor — pushed feat/wbs-relay; Gitea status confirmed; fleet check)

---

## 🔴 Do Now

### 0. Max sleeping — Bridge room permission lost, needs re-invite then `!wake max`
Max was explicitly `!sleep`'d on **2026-03-11 19:21 UTC** after M_FORBIDDEN on Bridge (`!NFmoaOD6U4pd2828Mt:a-gis.org`). Status in fleet.json: `"sleep"`. Max is managed by PM2 when awake (image `nanoclaw-max:latest`, Dockerfile at `bots/navigator/max/Dockerfile`) — no manual PM2 work needed.

Mention-wake events appearing at 17:54–18:00 UTC today are **false positives** — loudspeaker status reports containing "Max" match the `@Max\b` mention regex; wake silently bails when wakeConn roomId can't post back.

**Fix:** (1) Re-invite `@max-bot:a-gis.org` to Bridge room. (2) Run `!wake max` in Engineering. Relay handles the rest.
**Who:** Operator. 🔑

### 0c. Merge PR #35 — operator @mention + heartbeat trigger fix
Branch `origin/operator/fix-mention-trigger-v2`. Fixes two bugs in callout-mode bots:
1. `restoreMentionPrefixes` was case-sensitive and skipped `@`-prefixed names from pills
2. Heartbeat nudge didn't emit `<m>Name</m>` markers to trigger onduty bots

**Once merged:** relay git sync (every 3 min) detects code changes, auto-rebuilds and restarts. No manual deploy needed on Poseidon. Relay inbox item already flagged this.
**Who:** Operator merge on GitHub. 🔑

### 0b. `!wake cid` silently failing — Cid assigned to HERACLES in fleet.json
Operator ran `!wake cid` in Engineering at 17:04 and 18:03 UTC today — both silently failed. Root cause: `fleet.json` has `cid.ship = "HERACLES"`. Poseidon's relay ignores wake commands for bots not assigned to its ship. Same issue explains repeated `!wake murdock` failures (murdock.ship = "mac139160").

**To wake Cid on Poseidon:** edit `~/.config/infiniclaw/secrets/bots/fleet.json`, change `cid.ship` from `"HERACLES"` to `"Poseidon"`, commit+push the secrets repo, then run `!wake cid` again.
**Alternative:** bring up HERACLES machine (where Cid lives) and run `!wake cid` from there.
**Who:** Operator. 🔑

### 1. Design doc review cycle — three PRs open, all need merge
- **docs #7+#8:** Branch `docs/fix-07-ipc-08-threading-accuracy`. All 181 tests pass.
- **doc #9:** Branch `docs/fix-09-roles-and-rooms-accuracy`. All 181 tests pass.
- **doc #10:** Branch `docs/fix-10-fleet-accuracy` pushed 2026-03-14 ~18:30. All 181 tests pass.
  - `10-fleet.md`: stale report handling corrected (not ignored — used as secondary fallback; merge: fresh > stale > liveFleet), availability definition fixed (excludes transit bots, not just sleeping)
  - `README.md`: updated 10-fleet.md entry to reflect three-tier assembly and precise availability definition
- **Next doc:** #11 (11-commands.md) — Parker to continue.

**Who:** Operator to merge PRs. Parker to continue with doc #11 (11-commands.md).
**PRs:**
- https://github.com/wawiesel/InfiniClaw/pull/new/docs/fix-07-ipc-08-threading-accuracy
- https://github.com/wawiesel/InfiniClaw/pull/new/docs/fix-09-roles-and-rooms-accuracy
- https://github.com/wawiesel/InfiniClaw/pull/new/docs/fix-10-fleet-accuracy

---

## 🟠 High Priority

### 2. Brain timeout cascade — resume context flood (issue #21) — ✅ PR OPEN
Committed on `feat/wbs-relay` (commit `b49c731`). `injectResumeMessage()` now fetches 5 messages instead of 10.
**PR:** https://github.com/wawiesel/InfiniClaw/pull/new/feat/wbs-relay (same PR as WBS + item #3)
**Who:** Operator merge. 🔑

### 3. Boot pip transitions (🔄 → 🚀 → 🟡 → 🟢) — ✅ PR OPEN
Committed on `feat/wbs-relay` (commit `b49c731`). `MatrixChannelOpts.pipFormatter` hook wires `setStatusPip` to `setDisplayName`.
**PR:** https://github.com/wawiesel/InfiniClaw/pull/new/feat/wbs-relay (same PR as WBS + item #2)
**Who:** Operator merge. 🔑

### 4. Invite `@loudspeaker` to BehindTheCurtain room — M_FORBIDDEN noise
Root cause found: `relay.ts:3158` mirrors command output to BehindTheCurtain using `@loudspeaker:a-gis.org`, but that account is not in the room. Code handles it gracefully (falls through, `matrix-api.ts:185` logs "send failed"), so the main Engineering room sends work fine. The errors are noisy but non-fatal.
**Fix:** Operator invites `@loudspeaker:a-gis.org` to `!dqIeOQH0GAZWhrajUz:a-gis.org` (BehindTheCurtain). One Matrix command: `/invite @loudspeaker:a-gis.org` in BTC.
**Who:** Operator. 🔑

### 5. @room cross-room routing from bots
Bots cannot currently send messages to another room (e.g., engineer → astrometrics). `@room:` is unimplemented. This would enable proper cross-room delegation.
**Design:** `02-matrix.md`, `13-intercom.md`.
**Who:** Parker.

---

## 🟡 Medium Priority

### 6. Context injection: fan main timeline messages to active branch brains
When a new message arrives on the main timeline, the relay should fan it to all active branch brain IPC queues with context (it may not apply; brain ignores if irrelevant).
**Design:** `08-threading.md` — "Context Injection" status block.
**Who:** Parker.

### 7. Thread reactivation — follow-up messages spawn new branch brains
After a branch brain completes, follow-up messages in that thread should be able to spawn a new branch brain continuing the work. Currently impossible.
**Design:** `08-threading.md` — "Thread reactivation" status block.
**Who:** Parker.

### 8. Per-task model selection for branch brains — ✅ PR OPEN
Branch `feat/per-task-model-selection` pushed. 3-file fix:
- `bots/container/agent-runner/src/delegate-runner.ts`: added optional `model` param to `branch_to_thread` tool
- `src/relay.ts:spawnBranchBrain`: added `model?` to task type; extracts from relay-task JSON
- `src/relay.ts` childEnv: sets `ANTHROPIC_MODEL = task.model || botEnv.BRAIN_MODEL || ''`
**PR:** https://github.com/wawiesel/InfiniClaw/pull/new/feat/per-task-model-selection
**Design:** `06-brain.md` — "Per-task model selection" status block.
**Who:** Operator merge. 🔑

### 9. NAS/infrastructure documentation — remaining gaps
Full architecture docs now exist in `workspace/persona/docs/` (architecture-overview, nas-synology, portainer, networking, services, backups). Remaining gaps:
- Disk count, individual disk models, RAID configuration (needs DSM Storage Manager SSH or UI)
- Backup/Hyper Backup config (API returned 103/403) — flagged CRITICAL in backups.md
- Synology Drive sync config (which clients sync to which dirs)
- [x] ~~How matrix.a-gis.org routes to conduwuit~~ — **CORRECTED** (Branch Brain, 2026-03-14): Prior note was wrong. Eero forwards port 443 → NAS (not Poseidon). NAS runs nginx (port 443) as the real public TLS terminator. NAS nginx proxies `matrix.a-gis.org → Poseidon:6167` (conduwuit) and `s3.a-gis.org → Poseidon:9000` (MinIO) via LAN. Caddy on Poseidon handles only local/Tailscale clients for `a-gis.org` and `matrix.a-gis.org`. **`networking.md` still needs correction — the public traffic path goes through NAS nginx, not Caddy.**
- [x] ~~`s3.a-gis.org` routing~~ — **RESOLVED** same investigation: NAS nginx proxies `s3.a-gis.org → Poseidon:9000` (MinIO). Confirmed via `x-amz-id-2` hash match between NAS:443 direct and public access.
**Who:** Operator/Tali — update networking.md to reflect NAS nginx as public entry point. Low urgency.

---

## 🟢 Lower Priority

### 10. Lobe end-to-end workflow
`delegate_to_lobe` tool exists but the full workflow (quarters thread posting, completion notification, bot pickup) is not production-ready.
**Design:** `06-brain.md` — Lobe section.
**Who:** Parker or Cid (when HERACLES active).

### 11. Branch brain upgrade: full interactive session
Replace one-shot `claude --print` with a full nanoclaw group container session. Enables resumable, interactive, time-limited branch brains.
**Design:** `08-threading.md` — "Branch Brain Upgrade" status block.
**Who:** Parker + Cid collaboration.

### 12. Skills module (17-skills.md)
Pooled capability modules per role. Not yet implemented. Big feature.
**Design:** `17-skills.md`.
**Who:** Architect (Albert when HERACLES active) + engineers.

### 14. Cross-machine health — implement doc 21
Design complete (`docs/design/21-cross-machine-health.md`, committed 2026-03-14). Adds 5-min beacon flush, sync status fields (`secrets_sync`, `git_sync`), staleness classification (LIVE/STALE/OFFLINE), fleet aggregation pull model, `check_health scope=fleet`, and Matrix alerts on machine transitions.
**Design:** `21-cross-machine-health.md`.
**Who:** Parker or Cid.

### 13. NAS housekeeping (Mount-Olympus)
Research complete (Branch Brain, 2026-03-14). Plans documented in `nas-synology.md`. Remaining items all require operator action:
- **Prune stale images:** `docker image prune` on NAS — safe, ipfs is stopped. Frees ~3–4 GB.
- **Gitea:** Container is **stopped** (clean exit ~2026-03-03). DNS record `gitea.a-gis.org` is **NXDOMAIN** (never created or deleted). Caddy on Poseidon has no `gitea.a-gis.org` block. To restore: (1) start Portainer stack ID 5 on NAS, (2) add `gitea.a-gis.org → 69.131.213.135` A record in GoDaddy, (3) add Caddy reverse_proxy block on Poseidon, (4) optionally add Eero port 2223 forward for SSH. OR migrate Gitea to Poseidon entirely (Tali has the migration plan).
- **aufs → overlay2:** Research shows DS420j ARM64 kernel may not support overlay2 module. **Recommendation: do NOT migrate manually — wait for Synology Container Manager to handle in a future update.** Plan documented in nas-synology.md if forced.
- **IPFS decommission:** Stack dead 11 months. Recommend operator confirm decommission, then delete stack via Portainer and prune images. Steps in nas-synology.md.
**Who:** Operator. 🔑

---

## 📋 Housekeeping

- Design doc cycle: docs #7+#8, #9, #10 all have open PR branches. Need operator merge.
- **Max:** intentionally sleeping since 2026-03-11 19:21 UTC (item #0). Mention-wake FPs from loudspeaker status reports matching `@Max\b` — non-fatal, expected.
- **Relay M_FORBIDDEN (`!dqIeOQH0GAZWhrajUz`):** `@loudspeaker` not in BTC room (item #4). Non-fatal.
- **Portainer credentials were in plaintext task prompt** — operator must rotate Portainer admin password and store in vault.
- **feat/wbs-relay PR open:** items #2 (resume context 10→5), #3 (setStatusPip), plus WBS wiring (5 commits). **Item #8** (per-task model selection) still on separate `feat/per-task-model-selection` branch — needs its own PR.
- Parker: PM2 online (pid 1378939), 0 restarts. Relay: PM2 online (pid 1377294), 4 restarts. Tali: PM2 online (pid 1380009), 0 restarts.
- **conduwuit** (Matrix): running on Poseidon via podman. **minio** (S3): running on Poseidon via podman.
- **Gitea:** container stopped on NAS, DNS NXDOMAIN. See item #13 for full repair steps.
- NAS docs complete in `workspace/persona/docs/`. Portainer/DSM creds must be vaulted.
