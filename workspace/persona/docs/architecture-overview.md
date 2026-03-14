# Home Server Architecture — Overview

_Last updated: 2026-03-14_

---

## Summary

The home infrastructure consists of two physical machines (a Synology NAS and an Ubuntu Linux host), connected both via a local LAN (Eero mesh) and a Tailscale overlay VPN. Public internet services are exposed through GoDaddy DNS → a static public IP → Eero port forwarding → Synology DSM reverse proxy.

---

## Network Topology

```
Internet
    │
    ▼
GoDaddy DNS
    │  *.a-gis.org → 69.131.213.135
    ▼
Public IP: 69.131.213.135
    │
    ▼
Eero Mesh Router (home LAN gateway)
    │  Port forwards (see table below)
    ▼
Mount-Olympus (Synology NAS)
    │  192.168.5.123  MAC: 90:09:d0:20:06:d3
    │  DSM built-in Reverse Proxy → subdomains
    ├──▶ gitea.a-gis.org  → gitea container (stopped)
    ├──▶ s3.a-gis.org     → MinIO (presumed)
    ├──▶ matrix.a-gis.org → conduwuit (port 443)
    └──▶ ipfs.a-gis.org   → ipfs container (planned, not running)

Tailscale Overlay (100.x.x.x mesh)
    ├── Mount-Olympus  — Tailscale IP (NAS, via DSM package)
    └── Poseidon       — 100.99.145.27 (Ubuntu fleet host)
```

---

## Machines

### Mount-Olympus — Synology NAS

| Field | Value |
|---|---|
| Hostname | `Mount-Olympus` |
| Local IP | `192.168.5.123` |
| MAC | `90:09:d0:20:06:d3` |
| Model | Synology DS420j (ARM64, 4-core Cortex-A15) |
| DSM | 7.3.2-86009 Update 1 |
| RAM | 1 GB |
| Storage | 7.86 TB (volume1), ~0.99 TB used |
| Role | Container host, reverse proxy, file storage, services |

See [nas-synology.md](nas-synology.md) for full NAS detail.
See [portainer.md](portainer.md) for Docker/container inventory.

### Poseidon — Ubuntu Linux

| Field | Value |
|---|---|
| Hostname | `Poseidon` |
| Local IP | `192.168.6.149` |
| Tailscale IP | `100.99.145.27` |
| OS | Ubuntu Linux |
| Runtime | podman |
| Role | Fleet host (bot runners, automation, conduwuit, minio) |

Podman containers on Poseidon (confirmed 2026-03-14):
- `conduwuit` — `ghcr.io/continuwuity/continuwuity:latest` — Matrix homeserver
- `minio` — `quay.io/minio/minio` — S3-compatible object storage (up 11+ days)

---

## DNS

| Provider | Domain | Record | Target |
|---|---|---|---|
| GoDaddy | `a-gis.org` | A (wildcard or per-subdomain) | `69.131.213.135` |

All `*.a-gis.org` subdomains resolve to the static public IP. The Eero router forwards specific ports to Mount-Olympus, which routes by hostname using the DSM reverse proxy.

---

## Eero Port Forwards

| External Port(s) | Protocol | Internal Host | Purpose |
|---|---|---|---|
| 80 | TCP | 192.168.5.123 | HTTP (redirect / ACME) |
| 443 | TCP | 192.168.5.123 | Matrix/conduwuit (HTTPS) |
| 2223 | TCP | 192.168.5.123 | Gitea SSH |
| 9000 | TCP | 192.168.5.123 | Portainer web UI |
| 445 | TCP | 192.168.5.123 | SMB2 |
| 137–139 | TCP/UDP | 192.168.5.123 | SMB (NetBIOS) |

### ⚠️ Security Warning — SMB Exposed to Internet

Ports 137, 138, 139, and 445 (SMB/NetBIOS) are forwarded from the public internet to the NAS. **This is a significant security risk.** SMB should never be exposed to the internet:

- SMB vulnerabilities (EternalBlue, etc.) are actively exploited in the wild.
- Brute-force and ransomware attacks target exposed SMB ports.
- **Recommended action:** Remove these port forwards from Eero immediately. Access SMB only via Tailscale VPN.

---

## Tailscale Overlay

Tailscale provides an encrypted mesh VPN connecting both machines regardless of local subnet. Used for:
- Accessing Portainer internally: `http://100.88.101.126:9000`
- Fleet bot access from Poseidon
- Secure inter-machine communication without exposing ports publicly

---

## Traffic Flow (Public Service)

```
User browser → https://gitea.a-gis.org
    → GoDaddy DNS resolves to 69.131.213.135
    → Eero (NAT, no explicit port forward for 443 gitea — uses reverse proxy)
    → Mount-Olympus:443
    → DSM Reverse Proxy (hostname-based routing)
    → gitea container (when running)
```

Matrix/conduwuit specifically uses port 443, forwarded directly from Eero.

---

## See Also

- [nas-synology.md](nas-synology.md) — NAS hardware, storage, packages, users
- [portainer.md](portainer.md) — Docker containers, stacks, networks, images
- [networking.md](networking.md) — DNS, Tailscale, Eero, routing detail
- [services.md](services.md) — Individual service descriptions
- [backups.md](backups.md) — Backup status (CRITICAL: none configured)
