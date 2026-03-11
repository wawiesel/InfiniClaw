# 01 — Operator

The operator is the first entity in the system. Before any bot, relay, or ship exists, the operator bootstraps everything from scratch. The operator is a human with a Claude Code tmux session on a host machine and a Matrix account (`@operator`) on the homeserver.

## Bootstrap Sequence

Starting from nothing:

1. **Matrix server** — Conduwuit homeserver is running (see `docs/solutions/matrix.md`).
2. **BehindTheCurtain** — Operator creates the first room: a private channel between Captain and operator. This establishes the command link. Room naming: `🌑🎭 BehindTheCurtain`.
3. **Operator and loudspeaker accounts** — Registered on the homeserver. Operator joins BehindTheCurtain. Captain is admin (power 100) in all rooms.
4. **Secrets repo** — Operator initializes the secrets repo with `operator/`, `bots/fleet.json`, and credentials.
5. **First ship** — Operator registers this machine in `ships.json`, creates a ship space, lounge, and quarters space on Matrix.
6. **First bot (Norm)** — The simplest test: a normie with env file, fleet.json entry, and a quarters room. No duty rooms, no skills, no MCP. Just conversation in quarters. This validates the entire bot runtime end-to-end.
7. **Relay** — Operator starts the relay. It connects to Matrix, discovers Norm, wakes him. The system is alive.
8. **Growth** — Add more bots, more ships, duty rooms, intercom accounts. Each layer builds on what the operator already established.

Everything grows from BehindTheCurtain outward.

## Accounts

| Account | Credential file | Purpose |
|---------|----------------|---------|
| `@operator` | `operator-matrix.json` | Direct presence — messages, room management, admin ops |
| `@loudspeaker` | `loudspeaker-matrix.json` | Relay reply voice for x-commands |

Operator is admin (power 100) in every room. All room creation, invites, and power-level changes go through the operator account. Intercom accounts are write-only broadcast channels — never used for admin.

## Captain Communication

The Captain communicates with operators via BehindTheCurtain. The relay watches this room and forwards messages to the operator's tmux session.

**Routing:**
- **Default**: Only the **speaker** operator receives Captain messages. The speaker is the operator on the ship running the newest code (same election as relay speaker).
- **Broadcast**: Captain uses `📞 Operator` pill to send to **all** active operators simultaneously.
- **Direct**: Captain can also send x-commands from any room the operator account has joined — BehindTheCurtain, duty rooms, quarters rooms.

Operators reply via `bash operator/matrix reply "<response>"` — always back to Matrix, never in Claude Code output.

## Inter-Operator Communication

Multiple ships mean multiple operators. The only coordination channel is `operator/inbox.md` in the secrets repo. Operators do not use intercom rooms (engineering, bridge, astrometrics) to talk to each other.

Inbox items are structured with a target ship name. Each operator reads items targeting their ship, acts on them, marks them done, and pushes.

## X-Commands

X-commands are `!`-prefixed messages that control the fleet. X for exclamation, X for eXecute. The Captain types them in Matrix; every ship's relay processes them.

X-commands work from any room the operator account has joined. The full reference is in [11-commands](11-commands.md). The command registry (`command-registry.ts`) is the single source of truth for command names.

**Who can issue x-commands:** Captain (by user ID) and intercom accounts (by sender pattern). Operators issue x-commands via intercom scripts (`bash operator/matrix send <room> "!command"`).

**Bots cannot use x-commands.** X-commands are Captain/operator only. Bots use IPC for self-service operations (restart, rebuild, git push).

## Intervention

**When to intervene:**
- Bot is stuck, lazy, inefficient, broken, or needs a restart

**How to intervene (escalating):**
- **Mild**: Message the bot directly — `bash operator/matrix send <room> "@<bot> <message>"`
- **Medium**: X-commands — `!rejoin <bot>`, `!dismiss <bot>`, `!report <bot>`
- **Heavy**: Edit persona/config, then `!rejoin <bot>`
- **Fallback**: Restart the relay

**When NOT to intervene:**
- Bot is working. Let it work.
- Bot made a minor mistake. It will self-correct.
- You want to "improve" something proactively. Don't.

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
