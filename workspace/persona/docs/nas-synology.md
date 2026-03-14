# NAS: Mount-Olympus (Synology)

_Last inventoried: 2026-03-14 via DSM API (authenticated session)_

## Access

| Field | Value |
|-------|-------|
| Hostname | `Mount-Olympus` |
| Local IP | `192.168.5.123` |
| DSM Web UI | `https://192-168-5-123.ch-wieselquist.direct.quickconnect.to:5001/` |
| QuickConnect ID | `ch-wieselquist` |
| Protocol | HTTPS, port 5001 |

> **Security note:** DSM credentials must be stored in operator-secured secret storage (vault / environment variable), not in plaintext in task prompts or code.

---

## System Info

| Field | Value |
|-------|-------|
| Model | **Synology DS420j** |
| Serial | `2250S3RA56JZ5` |
| DSM Version | **DSM 7.3.2-86009 Update 1** |
| RAM | **1024 MB** |
| CPU temp | 46 °C (no warning) |
| Uptime at inventory | ~9.4 days (816,205 s) |
| System time | Sat Mar 14 12:48:34 2026 |

The DS420j is a 4-bay J-series (home/SOHO) NAS with an ARM Cortex-A15 quad-core CPU.

---

## Storage

### Volume

All shares reside on a single volume:

| Volume | Mount | Total | Free | Used |
|--------|-------|-------|------|------|
| volume1 | `/volume1` | 7.86 TB (7,863,224,451,072 B) | 6.87 TB (6,874,803,273,728 B) | ~0.99 TB |

The volume is read-write. Disk/RAID pool details were not accessible via the API under the current user permissions (error 103 — requires Storage Manager admin privilege). The DS420j supports up to 4 drives; RAID config (SHR, RAID 1/5/6, Basic) is not determinable from the API alone.

### Shared Folders

| Name | Real Path | Description | Encrypted |
|------|-----------|-------------|-----------|
| `docker` | `/volume1/docker` | Docker container data | No |
| `homes` | `/volume1/homes` | All user home directories | No |
| `home` | `/volume1/homes/wawiesel` | wawiesel's home (virtual) | No |
| `music` | `/volume1/music` | System default (media) | No |
| `MyStore` | `/volume1/MyStore` | "Liz and Will home file storage" | No |
| `photo` | `/volume1/photo` | System default (Synology Photos) | No |
| `video` | `/volume1/video` | System default (media) | No |
| `web` | `/volume1/web` | System default (web server) | No |
| `web_packages` | `/volume1/web_packages` | Web package data | No |

All shares use ACL mode. No shares are encrypted at rest.

---

## User Accounts

| Username | Description | Email | Status |
|----------|-------------|-------|--------|
| `admin` | Disabled admin | — | **Expired/Disabled** |
| `guest` | Guest | — | Normal |
| `smb` | SMB service account | william.wieselquist@gmail.com | Normal |
| `wawiesel` | Main account | william.wieselquist@gmail.com | Normal |

**Groups:** `administrators`, `http`, `users`

- Built-in `admin` account is correctly disabled (security best practice).
- `smb` account appears to be a dedicated service account for SMB file sharing.
- `wawiesel` is the primary human user (uid 1026).

---

## Installed Packages

| Package ID | Display Name | Version |
|------------|-------------|---------|
| `ActiveInsight` | Active Insight | 3.0.5-24122 |
| `ContainerManager` | Container Manager (Docker) | 24.0.2-1606 |
| `FileStation` | File Station | 1.4.3-1609 |
| `Git` | Git Server | 2.39.1-1079 |
| `MediaServer` | Media Server | 2.2.1-3406 |
| `Node.js_v16` | Node.js v16 | 16.20.2-2014 |
| `Node.js_v18` | Node.js v18 | 18.18.2-1011 |
| `Node.js_v20` | Node.js v20 | 20.9.0-1003 |
| `OAuthService` | OAuth Service | 1.2.0-0163 |
| `Python2` | Python 2 | 2.7.18-1004 |
| `Python3.9` | Python 3.9 | 3.9.14-0010 |
| `QuickConnect` | QuickConnect | 1.0.9-0171 |
| `SMBService` | SMB Service | 4.15.13-3045 |
| `ScsiTarget` | SAN Manager (iSCSI) | 1.0.12-0338 |
| `SecureSignIn` | Secure SignIn Service | 1.1.6-0391 |
| `StorageManager` | Storage Manager | 1.0.1-1100 |
| `SynoFinder` | Universal Search | 1.9.0-0900 |
| `SynologyApplicationService` | Synology Application Service | 1.8.2-20726 |
| `SynologyDrive` | Synology Drive Server | 3.5.2-26111 |
| `SynologyPhotos` | Synology Photos | 1.8.2-10090 |
| `Tailscale` | Tailscale | 1.58.2-700058002 |
| `TextEditor` | Text Editor | 1.2.5-0254 |
| `UniversalViewer` | Universal Viewer | 1.3.0-0312 |

Notable: **Tailscale** is installed, enabling VPN mesh access to the NAS. Multiple Node.js runtimes suggest active development/hosting use.

---

## Container Manager (Docker)

Container Manager v24.0.2-1606 is installed. Full inventory completed via Portainer API (2026-03-14). See `portainer.md` for full detail.

### Containers (3 total, 1 running)

| Container | Image | State | Stack |
|-----------|-------|-------|-------|
| `portainer` | portainer/portainer-ce:latest | **Running** (9+ days) | standalone |
| `gitea` | gitea/gitea:latest (v1.23.5) | **Stopped** — exit 0, ~11 days ago | gitea (compose) |
| `ipfs` | wawiesel/ipfs-watcher:latest | **Stopped** — exit 137 (SIGKILL), ~11 months ago | ipfs (compose) |

### Compose Stacks

| Stack | ID | Compose path |
|-------|----|-------------|
| gitea | 5 | /data/compose/5/docker-compose.yml |
| ipfs | 8 | /data/compose/8/docker-compose.yml |

### Networks

| Network | Driver | Subnet |
|---------|--------|--------|
| `bridge` | bridge | 172.17.0.0/16 |
| `proxy` | bridge | 172.18.0.0/16 |
| `ipfs_default` | bridge | 172.20.0.0/16 |
| `host` | host | — |

### Docker health notes

- Storage driver: **aufs** (deprecated — see migration plan below)
- 14+ stale untagged `wawiesel/ipfs-watcher` images accumulating (~3–4 GB) — safe to prune (ipfs container is stopped)
- Gitea container stopped cleanly (exit 0, ~11 days) — unknown if deliberate
- IPFS container killed 11 months ago (exit 137) — appears abandoned; recommend decommission

### aufs → overlay2 Migration Plan

**Recommendation: do NOT migrate manually. Wait for Synology.**

Research (2026-03-14) found the DS420j's ARM64 custom kernel (4.4.302+) may not have the overlay2 kernel module compiled in, even though the version is technically sufficient. Multiple reports of "failed to mount overlay: no such device" on Synology ARM devices. The risk of a broken Docker daemon after migration is high.

**Safe path:**
- Monitor Container Manager release notes; Synology may handle driver migration in a future DSM update
- `aufs` is deprecated in Docker but not yet removed — no urgency for DSM 7.3.x
- If Synology removes aufs in a future update, they will likely provide a migration path

**If forced to migrate (last resort):**
1. Export all needed images: `docker save <image> > image.tar` for each
2. Stop all containers
3. Edit `/volume1/@docker/daemon.json` — add `"storage-driver": "overlay2"`
4. Restart Container Manager / Docker daemon
5. Verify: `docker info | grep "Storage Driver"` — if it shows `overlay2`, proceed; if error, revert
6. Re-pull or `docker load` images
7. Recreate containers (volumes in `/volume1/@docker/volumes/` are preserved)

**Data impact:** All images lost; volumes preserved. Full container recreation required.

### IPFS container decommission assessment

The `ipfs` Compose stack (ID 8) has been stopped for ~11 months via SIGKILL. The stack:
- Runs `wawiesel/ipfs-watcher:latest` (custom image)
- Mounts `/volume1/MyStore/ipfs-mirror` read-only (IPFS mirror source)
- Writes to `/volume1/web/status` (status page)
- Has 14+ stale build images (~3–4 GB)

**Recommendation:** Decommission unless there's a known plan to revive. Steps:
1. Confirm with operator that IPFS mirroring is no longer needed
2. `docker compose -f /data/compose/8/docker-compose.yml down -v` (or via Portainer stack delete)
3. `docker image prune` to remove dangling images
4. Archive or remove `/volume1/docker/ipfs/` data if not needed

---

## Backup Configuration

Hyper Backup and Network Backup APIs returned error 103 (connection timeout / insufficient privilege). Snapshot API returned 403 (forbidden). No backup configuration could be confirmed via API.

**Action needed:** Verify backup status manually in DSM → Hyper Backup and check if snapshot schedules are configured for any shares.

---

## Network

- DDNS records: **none configured** (empty records list)
- QuickConnect is installed and active (used for `ch-wieselquist.quickconnect.to` access)
- Tailscale VPN installed (see packages)
- No custom DDNS providers configured (relies on QuickConnect for remote access)

---

## API Access

All REST endpoints route through:
```
https://192-168-5-123.ch-wieselquist.direct.quickconnect.to:5001/webapi/entry.cgi
```

Authentication via:
```
POST /webapi/auth.cgi
  api=SYNO.API.Auth&version=3&method=login
  &account=<user>&passwd=<pass>&session=DSMagent&format=cookie
```

Returns `sid` token. Append `&_sid=<sid>` to subsequent requests.

**Permission notes:** Many admin APIs (Storage disk/pool/volume, Network, Certificates, Hyper Backup) require the session user to have Storage Manager / Administrator privileges. The `wawiesel` account can access packages, shares, users, FileStation, and Docker networks but not the deeper admin APIs.

---

## Open Items

- [ ] Verify disk count, individual disk models, and RAID configuration via DSM UI or SSH
- [ ] Confirm backup strategy (Hyper Backup destinations, snapshot schedules)
- [x] Investigate Docker containers — completed via Portainer API (2026-03-14)
- [x] Review Gitea container config — stopped (exit 0, ~11 days); Compose stack ID 5; bind: /volume1/docker/gitea → /data
- [x] Review IPFS container — stopped (SIGKILL, ~11 months); appears abandoned; Compose stack ID 8; mirrors /volume1/MyStore/ipfs-mirror read-only
- [ ] Python 2.7 is EOL — consider removing if not required
- [ ] Prune 14+ stale `wawiesel/ipfs-watcher` images on NAS (~3–4 GB waste)
- [ ] Plan aufs → overlay2 Docker storage driver migration (breaking change, requires operator)
- [ ] Confirm whether Gitea being stopped is intentional; restart via Portainer if needed
- [ ] Confirm whether IPFS stack should be removed or revived
