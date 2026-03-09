# Conduwuit Solutions

## Registration fails with "Invalid registration token"

**Problem:** `conduwuit-ctl enable-registration <token>` completes without error but registration API rejects the token.

**Cause:** `conduwuit-ctl` uses `set -euo pipefail`. The snapshot prune step (`xargs rm -rf`) fails on docker-owned files (permission denied), aborting the script before `docker stop` and `docker rm` run. The old container keeps running without the new env vars, so the token is never actually applied.

**Fix:**
```bash
# Remove old docker-owned snapshots via a privileged alpine container
docker run --rm -v ~/.config/conduwuit/snapshots:/snaps alpine \
  sh -c "rm -rf /snaps/<old-snapshot-dirs>"
# Then retry
conduwuit-ctl enable-registration <token>
```
Snapshots owned by docker (not the host user) can only be deleted this way without sudo.

**Prevention:** The `conduwuit-ctl` prune step should use `rm -rf ... || true` to be non-fatal. File a fix when convenient.

---

## conduwuit-ctl restart/enable-registration silently does nothing

**Problem:** Command exits with code 123, container still shows old start time.

**Cause:** Same as above — `set -e` exits early on prune failure before any restart logic runs.

**Fix:** See above. Clear docker-owned snapshots first.

---

## Snapshot directory fills with unremovable files

**Problem:** `~/.config/conduwuit/snapshots/` accumulates directories owned by root/docker that `rm -rf` can't delete as the host user.

**Cause:** Snapshots are created by a docker alpine container running as root, so files are owned by root on the host.

**Fix:**
```bash
docker run --rm -v ~/.config/conduwuit/snapshots:/snaps alpine rm -rf /snaps/<dirname>
```
