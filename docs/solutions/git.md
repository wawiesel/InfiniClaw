# Git Solutions

## Can't pull: "You have unstaged changes"

**Problem:** `git pull` fails because there are local modifications.

**Fix:**
```bash
git stash && git pull && git stash pop
```
If stash pop conflicts, resolve manually.

---

## Merge conflict in secrets repo on pull

**Problem:** `git pull` aborts with unmerged files (e.g. `ships.json`, `fleet.json`).

**Cause:** Two machines committed to the same file concurrently.

**Fix:** Inspect the conflict, take the correct version, then:
```bash
git add <file>
git commit -m "resolve merge conflict"
git push
```
For `ships.json`/`fleet.json`, prefer the version with more complete data (e.g. upstream if it has new fields).

---

## Presence files re-appearing after deletion

**Problem:** A deleted file (e.g. `operator/presence/*.json`) keeps coming back after git pull.

**Cause:** Another machine is still writing and pushing that file.

**Fix:** Find and stop the process writing it on the other machine, then delete and push again.

---

## CAPTAIN_USER_ID not being picked up by bots

**Problem:** Bot logs warn `CAPTAIN_USER_ID is empty`.

**Cause:** `CAPTAIN_USER_ID` was removed from individual bot env files and moved to `secrets/captain`. Bot start scripts must source `secrets/captain` to inject it. Old start scripts (before the fix in `src/service.ts`) don't do this.

**Fix:** Restart the bot via `!rejoin <bot>` — the relay regenerates the start script from current `service.ts` which sources `secrets/captain` automatically.
