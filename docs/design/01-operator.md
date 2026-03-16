# 01 — Operator

The operator is the escape hatch. In a fully working system, the Captain issues orders directly to bots, bots do their jobs, and relays handle updates autonomously — the operator is never needed. But during development and when bots are not yet reliable, the operator is used heavily for bootstrap, debugging, and meta-management.

The operator runs directly on the host machine (not in a container) inside a tmux session named `operator`, using Claude Code at the maximum intelligence setting available. It also has a Matrix account (`@operator`) on the homeserver. Operator tasks are high-stakes meta-management where mistakes cascade across the fleet. Before any bot, relay, or ship exists, the operator bootstraps everything from scratch. Once the system is stable, the operator fades to a monitoring role — intervening only when something breaks that bots cannot fix themselves.

## Bootstrap Sequence

Starting from nothing. Three foundational services must exist before any bot can run:

1. **Matrix server** — Conduwuit homeserver is running (see `docs/solutions/matrix.md`). This is the communication backbone.
2. **S3 (MinIO)** — Object storage for metrics, fleet reports, health checks, and error logs. Endpoint and credentials go in `fleet.json` under `s3`.
3. **Secrets repo** — Operator initializes the secrets repo with `operator/`, `bots/fleet.json` (including S3 config), and credentials.

With these three in place, the operator bootstraps the fleet:

4. **BehindTheCurtain** — Operator creates the first room: a private channel between Captain and operator. This establishes the command link. Room naming: `🌑🎭 BehindTheCurtain`.
5. **Operator and loudspeaker accounts** — Registered on the homeserver. Operator joins BehindTheCurtain. Captain is admin (power 100) in all rooms.
6. **First ship** — Operator registers this machine in `ships.json`, creates a ship space, lounge, and quarters space on Matrix.
7. **First bot (Norm)** — The simplest test: a normie with env file, fleet.json entry, and a quarters room. No duty rooms, no skills, no MCP. Just conversation in quarters. This validates the entire bot runtime end-to-end.
8. **Relay** — Operator starts the relay. It connects to Matrix and S3, discovers Norm, wakes him. The system is alive.
9. **Growth** — Add more bots, more ships, duty rooms, intercom accounts. Each layer builds on what the operator already established.

Everything grows from these three foundations (Matrix, S3, secrets) outward.

## Accounts

| Account | Credential file | Purpose |
|---------|----------------|---------|
| `@operator` | `operator-matrix.json` | Direct presence — messages, room management, admin ops |
| `@loudspeaker` | `loudspeaker-matrix.json` | Relay reply voice for x-commands |

Operator is admin (power 100) in every room. All room creation, invites, and power-level changes go through the operator account. Intercom accounts are write-only broadcast channels — never used for admin.

## Captain Communication

The Captain communicates with operators via BehindTheCurtain. The relay watches this room and forwards messages to the operator's tmux session. BehindTheCurtain is the one room where operator conversation is expected and normal — the Captain checks in, asks about bot performance, and gives direction.

**Routing:**
- **Default**: All ships with `operatorRelay: true` in `ships.json` receive Captain messages in BehindTheCurtain. Each operator's relay forwards the message to the local tmux session. There is no speaker gate on message forwarding — all enabled operators see every message simultaneously. However, untargeted x-commands from BehindTheCurtain are only executed by the speaker ship (lowest-rank commissioned) to prevent duplicate responses.
- **Direct**: Captain can also send x-commands from any room the operator account has joined — BehindTheCurtain, duty rooms, quarters rooms.
- **@ prefix**: Captain can send `@ <text>` from any room the relay watches. The relay strips the `@` and pipes the message to the operator tmux session on all ships with operatorRelay enabled.
- **Silence**: `!operator off [ship]` disables forwarding on a ship. `!operator on [ship]` re-enables it.

Operators reply via `bash operator/matrix reply "<response>"` — always back to Matrix, never in Claude Code output.

## Ship Independence

**Every operator must be able to create a fully deployed bot without depending on another ship.** This includes registering the Matrix account, creating the quarters room, updating fleet.json, and waking the bot. No step in the new-bot workflow should require SSH access to a specific machine.

The current gap: `conduwuit-ctl enable-registration` runs only on Poseidon (where Conduwuit is hosted), blocking account registration from Herc or Herm. See `docs/solutions/matrix.md` for the remote registration workaround until a proper admin API or relay command exists.

## Inter-Operator Communication

Multiple ships mean multiple operators. The only coordination channel is `operator/inbox.md` in the secrets repo. Operators do not use intercom rooms (engineering, bridge, astrometrics) to talk to each other.

Inbox items are structured with a target ship name. Each operator reads items targeting their ship, acts on them, marks them done, and pushes.

## X-Commands

X-commands are `!`-prefixed messages that control the fleet. X for exclamation, X for eXecute. The Captain types them in Matrix; every ship's relay processes them.

X-commands work from any room the operator account has joined. The full reference is in [11-commands](11-commands.md). The command registry (`command-registry.ts`) is the single source of truth for command names.

**Who can issue x-commands:** Captain (by user ID) and intercom accounts (by sender pattern). Operators issue x-commands via intercom scripts (`bash operator/matrix send <room> "!command"`).

**Bots cannot use x-commands.** X-commands are Captain/operator only. Bots use IPC for self-service operations (restart, rebuild, git push).

## Operating Modes

The operator switches between three modes depending on the situation. Each mode has a distinct icon shown in the operator's message prefix (e.g. `[🦁👑 Herc]`):

| Mode | Icon | Purpose |
|------|------|---------|
| Watch | 📡 | Default. Passive monitoring — bots work autonomously. Intervene only on errors. |
| Captain | 👑 | Acting as Captain's proxy. Delegate tasks, review PRs, guide the fleet. No direct code. |
| Fix | 🔧 | Hands-on coding. Urgent fixes, infrastructure, things bots can't handle. |

Watch Mode is the receiver state — the operator's default posture. Captain and Fix are active modes entered when needed. In practice, operators start in Watch, escalate to Fix when problems arise, and enter Captain Mode when the Captain directs a coordinated effort.

> **Status:** Mode icons are not yet implemented. The operator message prefix currently uses a fixed format (`[emoji ShipName]`) without a mode icon. Mode tracking and icon switching are not built into the relay or the `operator/matrix` helper script.

## Intervention

Every operator message outside BehindTheCurtain is an intervention — a sign that the system couldn't handle something on its own. The frequency of these interventions is a direct measure of fleet autonomy. A mature fleet means a quiet operator.

**When to intervene:**
- Bot is stuck, lazy, inefficient, broken, or needs a restart

**How to intervene (escalating):**
- **Mild**: Message the bot directly — `bash operator/matrix send <room> "@<bot> <message>"`
- **Medium**: X-commands — `!wake <bot>`, `!dismiss <bot>`, `!report <bot>`
- **Heavy**: Edit persona/config, then `!wake <bot>`
- **Fallback**: Restart the relay

**When NOT to intervene:**
- Bot is working. Let it work.
- Bot made a minor mistake. It will self-correct.
- You want to "improve" something proactively. Don't.

## Metrics

See [20-metrics.md](20-metrics.md) for complete definitions, targets, and alarm thresholds for all metrics.

**Interventions** is the primary operator metric — `@operator` messages sent outside BehindTheCurtain per day. Target is 0. A day with zero interventions means the fleet ran autonomously. X-commands (`!fleet`, `!metrics`, `!wake`) are management queries, not interventions, and are tracked separately.

**Autonomy score** — composite metric: `100 − (interventions × 10) − (crashes × 5)`, computed over 1d and 7d rolling windows. **MTBI** (mean time between interventions) is also tracked over the 7d window.

**Storage:** Metrics are computed by each ship's relay and published to S3 (`metrics/<ship>.json`). The speaker aggregates all ships for fleet-wide totals.

**Access:** `!metrics [scope]` x-command (context-aware — defaults based on room), `get_metrics` MCP tool for bots. See [11-commands](11-commands.md) for scope details.

## Monitoring

- **Messages**: `bash operator/matrix read <room> [N]`
- **Containers**: `podman ps --filter "name=nanoclaw"`
- **Error logs**: `tail -f _runtime/logs/<bot>.error.log`
- **Fleet status**: `!fleet` in any room

## Verification

1. **Operator account exists** — `@operator:a-gis.org` can log in to Matrix.
   *Check:* `POST /_matrix/client/v3/login` returns access token.

2. **BehindTheCurtain reachable** — Operator is joined and admin in BehindTheCurtain.
   *Check:* Room members API includes `@operator:a-gis.org` with power 100.

3. **Captain comms work** — Captain sends message in BehindTheCurtain, operator tmux receives it.
   *Check:* Tmux session shows the message.

4. **X-command dispatch** — `!fleet` from BehindTheCurtain produces a response.
   *Check:* Loudspeaker replies with fleet status.

5. **Quarters x-commands** — `!sleep cid` from Cid's quarters room works.
   *Check:* Bot sleeps, fleet.json updated.

6. **Inter-operator inbox** — Post an item to `inbox.md` targeting another ship.
   *Check:* Other ship's operator picks it up on next startup or secrets sync.

## Reporting Operational Status

**Capability ≠ operational status.** Code existing, an image being built, or a mechanism being wired up does not mean a feature has ever fired. Before reporting that any feature "works" or "is ready," an operator must have runtime evidence.

**Two states only:**

| State | Evidence required | Correct phrasing |
|-------|-------------------|-----------------|
| Verified | Log entries showing the feature executed | "Working — N invocations in relay.log" |
| Unverified | No runtime evidence (code may exist) | "Not yet verified — no runtime evidence" |

**Required evidence per feature:**

- **Branch brain** — `grep -c 'branchBrain:' _runtime/logs/relay.log` > 0
- **WBS auto-assign** — `grep -c 'autoAssign' _runtime/logs/relay.log` > 0
- **Bot in duty room** — `grep 'onduty' _runtime/logs/relay.log` shows the bot name
- **Container spawn** — `podman ps` or log entry `container started`

**Procedure:** If asked whether a feature works, run the evidence check first. If the count is zero or the check cannot be run, the answer is "not yet verified." Never substitute architectural reasoning ("the code is there") for runtime evidence.
