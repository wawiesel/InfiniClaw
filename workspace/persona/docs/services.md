# Services — Home Server Infrastructure

_Last updated: 2026-03-14_

All public services resolve via `*.a-gis.org` → `69.131.213.135` (static public IP) → Eero → Mount-Olympus DSM Reverse Proxy.

---

## Gitea — Git Hosting

| Field | Value |
|---|---|
| Public URL | `https://gitea.a-gis.org` |
| SSH | `ssh://git@gitea.a-gis.org:2223` |
| SSH port forward | Eero 2223 → 192.168.5.123:2223 |
| Container | `gitea/gitea:latest` (v1.23.5 running; v1.25.4 available) |
| Container state | **Stopped** (clean exit, ~11 days ago as of 2026-03-14) |
| Stack | Portainer stack ID 5, compose: `/data/compose/5/docker-compose.yml` |
| Data volume | `/volume1/docker/gitea` → `/data` |
| Docker network | `proxy` (172.18.0.0/16) |

**Status:** Gitea is not currently running. The container exited cleanly (exit 0); this may be intentional or an accidental stop. Restart via Portainer if needed.

**Action needed:**
- [ ] Confirm whether Gitea should be running; restart if so
- [ ] Consider upgrading from v1.23.5 → v1.25.4 (newer image already pulled)

---

## S3 / MinIO — Object Storage

| Field | Value |
|---|---|
| Public URL | `https://s3.a-gis.org` |
| Host | **Poseidon** (192.168.6.149 / Tailscale 100.99.145.27) |
| Container | `minio` — `quay.io/minio/minio` |
| Container state | **Running** — up 11 days |
| Runtime | podman (on Poseidon) |

**Status:** MinIO is running on Poseidon via podman, not on the NAS. Up 11+ days continuously. DNS routes `s3.a-gis.org` → public IP → Eero → (TBD: NAT or Tailscale) → Poseidon MinIO port.

---

## Matrix / conduwuit — Federated Chat

| Field | Value |
|---|---|
| Public URL | `https://matrix.a-gis.org` |
| Port | 443 (Eero forward: public 443 → 192.168.5.123:443, then proxied to Poseidon) |
| Implementation | conduwuit (continuwuity fork — `ghcr.io/continuwuity/continuwuity:latest`) |
| Host | **Poseidon** (192.168.6.149 / Tailscale 100.99.145.27) |
| Container | `conduwuit` — up 41 minutes (as of 2026-03-14 ~14:00) |
| Runtime | podman (on Poseidon) |

**Status:** conduwuit runs on Poseidon via podman. Eero forwards port 443 to Mount-Olympus, which reverse-proxies to Poseidon via Tailscale or LAN. Recently restarted (41 min uptime at time of observation).

---

## IPFS — Content-Addressed Storage

| Field | Value |
|---|---|
| Public URL | `https://ipfs.a-gis.org` (planned, not operational) |
| Container | `wawiesel/ipfs-watcher:latest` (custom image) |
| Container state | **Stopped** (SIGKILL, exit 137, ~11 months ago) |
| Stack | Portainer stack ID 8, compose: `/data/compose/8/docker-compose.yml` |
| Data volumes | `/volume1/docker/ipfs/data`, `/volume1/MyStore/ipfs-mirror` (read-only mirror) |
| Upstream image | `ipfs/kubo:latest` (83 MB) |
| Stale images | 14+ untagged `wawiesel/ipfs-watcher` build artifacts (~3–4 GB) |

**Status:** Effectively abandoned. Container was killed (not gracefully stopped) and has been dormant ~11 months. The IPFS gateway at `ipfs.a-gis.org` is not operational.

**Action needed:**
- [ ] Decide: revive IPFS service or decommission the stack
- [ ] If decommissioning: remove stack from Portainer, prune images (`docker image prune`)
- [ ] `/volume1/MyStore/ipfs-mirror` data should be reviewed before decommission

---

## DSM Remote Access

| Field | Value |
|---|---|
| DSM URL | `https://192-168-5-123.ch-wieselquist.direct.quickconnect.to:5001/` |
| QuickConnect ID | `ch-wieselquist` |
| Protocol | HTTPS, port 5001 |

QuickConnect provides remote DSM access via Synology's relay infrastructure. Not used for public service routing.

---

## Portainer — Container Management UI

| Field | Value |
|---|---|
| Tailscale URL | `http://100.88.101.126:9000` |
| Public forward | Eero 9000 → 192.168.5.123:9000 (publicly accessible — restrict!) |
| Version | portainer-ce (Community Edition) |
| Container | Running (9+ days uptime) |

> **⚠️ Security:** Portainer is accessible from the public internet on port 9000. It provides full Docker control. Access should be restricted to Tailscale only — remove the Eero 9000 forward.

---

## Service Health Summary

| Service | URL | Status |
|---|---|---|
| Gitea | gitea.a-gis.org | ⚠️ Container stopped (NAS) |
| S3/MinIO | s3.a-gis.org | ✅ Running (Poseidon, 11+ days) |
| Matrix/conduwuit | matrix.a-gis.org | ✅ Running (Poseidon, recently restarted) |
| IPFS | ipfs.a-gis.org | ❌ Abandoned (~11 months, NAS) |
| Portainer | (Tailscale) | ✅ Running (NAS) |
| DSM | (QuickConnect) | ✅ Running (NAS) |
