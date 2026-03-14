# Backups — Home Server Infrastructure

_Last updated: 2026-03-14_

---

## ⚠️ CRITICAL: NO BACKUPS CONFIGURED

As of 2026-03-14, **no backup configuration has been confirmed on Mount-Olympus**.

- Hyper Backup API: returned error 103 (timeout / insufficient privilege) — could not confirm presence or absence of jobs
- Snapshot API: returned 403 (forbidden)
- No backup jobs were observable via the DSM API under the `wawiesel` account

**This means ~1 TB of data on a single Synology volume may have zero offsite or redundant backup.** This includes:
- All Docker container data (`/volume1/docker/`)
- User home directories (`/volume1/homes/`)
- Shared family file storage (`/volume1/MyStore/` — "Liz and Will home file storage")
- Media: photos, music, video
- Gitea repository data (`/volume1/docker/gitea/`)

---

## What Is at Risk

| Share | Contents | Criticality |
|---|---|---|
| `MyStore` | Family file storage (Liz & Will) | **HIGH** |
| `docker/gitea` | All git repositories | **HIGH** |
| `homes/wawiesel` | User home directory | **HIGH** |
| `photo` | Synology Photos library | **HIGH** |
| `docker/ipfs` | IPFS node data | MEDIUM |
| `music`, `video` | Media (likely recoverable) | LOW |

---

## Disk / RAID Status

The DS420j is a 4-bay NAS. RAID configuration was not determinable via API (requires Storage Manager admin). Possibilities:

- **RAID 1 / SHR** — protects against a single drive failure but is NOT a backup (RAID ≠ backup)
- **Basic (single drive)** — no redundancy at all; any drive failure = total data loss
- **RAID 5 / SHR2** — requires 4 drives for double-parity; unlikely on 4-bay SOHO device at ~8 TB

**Action:** Verify disk/RAID setup in DSM → Storage Manager → Storage Pool.

---

## Recommended Backup Strategy

### Tier 1 — NAS Snapshots (fast, local)

Enable Synology **Snapshot Replication** for critical shared folders:
- `MyStore`, `homes`, `docker`, `photo`
- Hourly snapshots, retain 24 hours
- Daily snapshots, retain 30 days

This protects against accidental deletion and ransomware (snapshots are read-only).

### Tier 2 — Hyper Backup to Cloud (offsite)

Use **Hyper Backup** to replicate critical data to an offsite destination:

| Option | Notes |
|---|---|
| Backblaze B2 | Low cost (~$0.006/GB/mo), S3-compatible, Hyper Backup native support |
| AWS S3 | More expensive but reliable; native Hyper Backup support |
| Synology C2 | Synology's own cloud; integrated but vendor lock-in |
| Another NAS (offsite) | Ideal if a second NAS or friend's NAS is available |

Minimum offsite backup target: **MyStore + docker/gitea + homes** (~500 GB estimate).

### Tier 3 — Poseidon Cross-Backup (optional)

Poseidon (Ubuntu, 192.168.6.149) could act as a local secondary backup target via rsync over Tailscale:
```bash
rsync -avz --delete mount-olympus:/volume1/MyStore/ /backup/MyStore/
```
Schedule via cron. Not a substitute for offsite, but adds redundancy.

---

## Immediate Actions

- [ ] **Manually verify Hyper Backup** in DSM → Hyper Backup — confirm whether jobs exist
- [ ] **Check RAID/disk config** in DSM → Storage Manager → Storage Pool
- [ ] **Enable Snapshot Replication** for MyStore, homes, docker, photo
- [ ] **Set up Hyper Backup** to Backblaze B2 or equivalent for offsite
- [ ] **Test a restore** — backup without restore testing is incomplete

---

## API Access for Future Verification

To check Hyper Backup status with sufficient privilege, authenticate as a Storage Manager admin:

```
GET /webapi/entry.cgi?api=SYNO.Backup.Task&version=1&method=list&_sid=<sid>
```

Requires admin-level session. The `wawiesel` account returned error 103 — either the package is not installed or the account lacks the necessary privilege group.
