# Portainer Infrastructure — Mount-Olympus NAS

> **Last inventoried:** 2026-03-14
> **Portainer URL:** http://100.88.101.126:9000
> **Portainer version:** portainer-ce (Community Edition)
> **⚠️ Security note:** Portainer credentials must be stored in a secrets manager (e.g., Bitwarden, vault), NOT in code, prompts, or chat logs.

---

## Host / NAS Details

| Field | Value |
|---|---|
| **Hostname** | Mount-Olympus |
| **Local DNS** | mount-olympus.local |
| **OS** | Synology NAS |
| **DSM version** | 7.3.2 |
| **Architecture** | aarch64 (ARM64) |
| **Kernel** | 4.4.302+ |
| **CPU cores** | 4 |
| **RAM** | ~988 MB |
| **Docker version** | 24.0.2 |
| **Docker root** | /volume1/@docker |
| **Storage driver** | aufs (on extfs) — **deprecated**, will be removed in a future Docker release |
| **Cgroup driver** | cgroupfs (v1) |

---

## Environments (Portainer)

| ID | Name | Type | Public URL | Status |
|---|---|---|---|---|
| 3 | local | Docker Standalone | mount-olympus.local | Active |

---

## Containers

| Name | Image | State | Network | Ports | Stack |
|---|---|---|---|---|---|
| `/portainer` | portainer/portainer-ce:latest | **Running** (9 days) | bridge | 0.0.0.0:8000→8000, 0.0.0.0:9000→9000 | _(none — standalone)_ |
| `/gitea` | gitea/gitea:latest (v1.23.5) | **Exited** (0) — 11 days ago | proxy | _(none exposed)_ | gitea |
| `/ipfs` | wawiesel/ipfs-watcher:latest | **Exited** (137) — 11 months ago | ipfs_default | _(none exposed)_ | ipfs |

### Container bind mounts

**gitea:**
- `/volume1/docker/gitea` → `/data` (rw)

**ipfs:**
- `/volume1/docker/ipfs/data` → `/data/ipfs` (rw)
- `/volume1/MyStore/ipfs-mirror` → `/data/ipfs/files` (**read-only**)
- `/volume1/docker/ipfs/staging` → `/data/ipfs/staging` (rw)
- `/volume1/web/status` → `/web/status` (rw)

**portainer:**
- `/volume1/docker/portainer` → `/data` (rw)
- `/var/run/docker.sock` → `/var/run/docker.sock` (rw — gives Portainer full Docker control)

---

## Stacks (Docker Compose)

| ID | Name | Status | Created | Last Updated | Compose path |
|---|---|---|---|---|---|
| 5 | gitea | Deployed | 2022-03-20 | 2025-04-06 | /data/compose/5/docker-compose.yml |
| 8 | ipfs | Deployed | 2022-03-20 | 2025-03-29 | /data/compose/8/docker-compose.yml |

---

## Volumes

| Name | Driver | Mountpoint |
|---|---|---|
| gitea_gitea-data | local | /volume1/@docker/volumes/gitea_gitea-data/_data |

---

## Networks

| Name | Driver | Subnet | Notes |
|---|---|---|---|
| bridge | bridge | 172.17.0.0/16 | Docker default bridge |
| proxy | bridge | 172.18.0.0/16 | Used by gitea; likely reverse-proxy network |
| ipfs_default | bridge | 172.20.0.0/16 | Created by ipfs compose stack |
| host | host | — | Host network |
| none | null | — | Null/isolated network |

---

## Images

| Repository | Tag | Size | Notes |
|---|---|---|---|
| gitea/gitea | latest | 184 MB | v1.25.4 (newer than running container) |
| gitea/gitea | _(untagged)_ | 183 MB | v1.23.5 — image in use by stopped container |
| wawiesel/ipfs-watcher | latest | 576 MB | Custom IPFS watcher image (wawiesel) |
| wawiesel/ipfs-watcher | _(14 untagged)_ | ~227–576 MB | Build history — old iterations accumulating |
| ipfs/kubo | latest | 83 MB | Upstream IPFS Kubo node image |
| portainer/portainer-ce | latest | 261 MB | Running Portainer instance |

> **Note:** There are 14 untagged dangling `wawiesel/ipfs-watcher` images consuming significant disk space (~3–4 GB). Consider pruning with `docker image prune`.

---

## Key Observations

1. **Only Portainer is running.** Both gitea and ipfs are stopped. Gitea exited cleanly 11 days ago; ipfs was killed (exit 137 = SIGKILL) 11 months ago.

2. **NAS confirmed as Synology DSM 7.3.2** — detected via Docker Info `OperatingSystem`/`OSVersion` fields. ARM64 architecture. Host name: Mount-Olympus.

3. **Deprecated storage driver (aufs):** Docker's aufs driver is deprecated and will be removed in a future release. Plan migration to `overlay2` before upgrading Docker.

4. **Image debt:** 14+ stale ipfs-watcher images. Prune when safe.

5. **No Swarm, no Kubernetes** — pure Docker standalone.

6. **`proxy` network exists but has no active containers** — gitea is stopped. If a reverse proxy (e.g., Traefik, Nginx) is expected on this network, it's not present in this environment.

7. **Portainer has full Docker socket access** — standard for Portainer but represents high privilege.

---

## Access

- **HTTP:** http://100.88.101.126:9000
- **HTTPS:** https://100.88.101.126:9443 (TLS not configured in endpoint)
- **Tunnel port:** 8000 (Portainer Edge Agent tunnel)

> **Credentials:** Store in secure vault — do NOT commit to version control.
