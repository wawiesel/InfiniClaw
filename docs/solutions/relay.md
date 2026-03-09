# Relay Solutions

## Relay crash-loops with "fatal: Unknown command: sleep"

**Problem:** Relay starts, logs commit epoch, then immediately crashes. Repeats every ~5 seconds. pm2 shows high restart count.

**Cause:** `dist/` was built before a new command (e.g. `!sleep`) was added to the command registry. The stale dist runs against new relay code that references undefined commands.

**Fix:**
```bash
cd ~/2026-Nanoclaw/InfiniClaw
git pull
npm run build
npm run cli relay start
```

**Prevention:** Always `git pull && npm run build` before starting the relay after a fleet update. The `!refit` command does this automatically for running ships.

---

## Relay won't respond to !refit or any commands

**Problem:** Commands are sent but relay never replies or acts.

**Cause:** Relay is crash-looping (see above) or never connected to Matrix rooms.

**Diagnosis:**
```bash
tail -20 ~/2026-Nanoclaw/InfiniClaw/_runtime/logs/relay.error.log
```
Look for: crash loops, Matrix 502 errors, "initial sync done" (means connected).

**Fix:** Depends on cause. If crash-looping, rebuild. If Matrix errors, check conduwuit status.

---

## !relay status only shows for the speaker ship

**Problem:** Sending `!relay` reports status from one ship but other ships are silent.

**Cause:** Status handler was gated on `isSpeaker()`, so only the lowest-rank active ship replied. Non-speaker ships ignored the command entirely.

**Fix:** Each ship reports its own state via `shipReport()` (not `speakerReport()`). The `!relay` handler should never be gated on speaker status — every ship should respond for itself.

---

## Relay forwards curtain ! commands to tmux instead of executing

**Problem:** Captain sends `!fleet` from BehindTheCurtain. It appears in the operator tmux instead of executing fleet command.

**Cause:** curtainLoop forwarded all messages to tmux without checking if they were `!` commands first.

**Fix:** In curtainLoop, check `body.startsWith('!')` before the tmux forward branch and dispatch via `handleCommand()` instead.

---

## Secrets sync push fails: "incorrect old value provided"

**Problem:** Relay logs `secrets sync FAILED: 1 unpushed commit(s), push failed: incorrect old value provided`.

**Cause:** The relay committed a local change (e.g. fleet.json, ships.json status update) but the remote had moved ahead. git's atomic push check fails.

**Fix:**
```bash
cd ~/.config/infiniclaw/secrets
git status          # identify uncommitted or unpushed changes
git pull            # fast-forward if possible
git push
```
If there's a conflict, resolve and commit before pushing.
