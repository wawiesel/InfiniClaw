# Networking — Home Server Infrastructure

_Last updated: 2026-03-14 (reverse proxy chain re-corrected — NAS nginx confirmed as public entry point)_

---

## LAN — Eero Mesh Network

The home LAN is managed by an Eero mesh router system. Two subnets are in use:

| Subnet | Known Hosts |
|---|---|
| 192.168.5.0/24 | Mount-Olympus NAS (192.168.5.123) |
| 192.168.6.0/24 | Poseidon Ubuntu host (192.168.6.149) |

The Eero acts as the NAT gateway and DHCP server for both subnets. Port forwarding rules direct inbound web traffic to **Mount-Olympus NAS** (not Poseidon — see Eero Port Forwards below). The NAS nginx is the public TLS entry point and reverse-proxies to backend services on Poseidon.

---

## Public IP & DNS

| Field | Value |
|---|---|
| Static public IP | `69.131.213.135` |
| DNS registrar | GoDaddy |
| Primary domain | `a-gis.org` |

GoDaddy is configured with DNS records pointing `a-gis.org` (and subdomains) to the static residential IP `69.131.213.135`.

### Known DNS Records (verified 2026-03-14)

| Subdomain | Record | Target | Status |
|---|---|---|---|
| `s3.a-gis.org` | A | 69.131.213.135 | ✅ Active — NAS nginx → Poseidon:9000 (MinIO) |
| `matrix.a-gis.org` | A | 69.131.213.135 | ✅ Active — NAS nginx → Poseidon:6167 (conduwuit) |
| `gitea.a-gis.org` | — | — | ❌ NXDOMAIN — record not created or deleted |
| `ipfs.a-gis.org` | A | 69.131.213.135 | ❓ Unverified — IPFS container dead 11 months |

NAS DDNS: No Synology DDNS records are configured. QuickConnect (`ch-wieselquist`) is used for DSM remote access only, not for public service routing.

---

## Eero Port Forwards

Web traffic (ports 80/443) is forwarded to **Mount-Olympus NAS** (192.168.5.123). The NAS nginx handles TLS termination and proxies to backend services.

| Port(s) | Protocol | Forwards to | Service |
|---|---|---|---|
| 80 | TCP | Mount-Olympus:80 | HTTP — NAS nginx (redirects to HTTPS or serves DSM) |
| 443 | TCP | Mount-Olympus:443 | HTTPS — NAS nginx reverse proxy (matrix, s3, a-gis.org) |
| 2223 | TCP | Mount-Olympus:2223 | Gitea SSH |
| 9000 | TCP | Mount-Olympus:9000 | Portainer web UI (Tailscale only recommended) |
| 445 | TCP | Mount-Olympus:445 | SMB2 |
| 137–139 | TCP/UDP | Mount-Olympus:137–139 | SMB/NetBIOS |

> **⚠️ SMB on internet:** Ports 137–139 and 445 are exposed to the public internet. This is dangerous. Remove these forwards; access SMB only over Tailscale.

---

## NAS Nginx Reverse Proxy (on Mount-Olympus) — PUBLIC ENTRY POINT

The **Synology DSM built-in reverse proxy** (nginx) on Mount-Olympus is the **actual public TLS entry point** for all web services at `69.131.213.135`. It handles TLS termination and proxies to backend services on Poseidon by hostname.

Verified behavior (2026-03-14 Branch Brain probe):
- `http://s3.a-gis.org/` → NAS port 80 returns DSM redirect page (to HTTPS port 5001)
- `https://s3.a-gis.org/` → NAS nginx:443 → proxies to Poseidon:9000 (MinIO) — confirmed by matching `x-amz-id-2` hash
- `https://matrix.a-gis.org/` → NAS nginx:443 → proxies to Poseidon:6167 (conduwuit)

**Full matrix.a-gis.org traffic chain:**
```
matrix.a-gis.org:443
  → DNS (GoDaddy A → 69.131.213.135)
  → Eero NAT → Mount-Olympus:443
  → NAS nginx (TLS termination, vhost: matrix.a-gis.org)
  → Poseidon:6167 (conduwuit podman container, via LAN 192.168.6.149)
```

**Full s3.a-gis.org traffic chain:**
```
s3.a-gis.org:443
  → DNS (GoDaddy A → 69.131.213.135)
  → Eero NAT → Mount-Olympus:443
  → NAS nginx (TLS termination, vhost: s3.a-gis.org)
  → Poseidon:9000 (MinIO podman container, via LAN 192.168.6.149)
```

NAS nginx config is managed through **DSM Control Panel → Login Portal → Advanced → Reverse Proxy**. To add a new subdomain (e.g., `gitea.a-gis.org`), add a proxy rule there pointing to the target host:port.

---

## Caddy Reverse Proxy (on Poseidon) — LOCAL/TAILSCALE ONLY

**Caddy** (`/usr/bin/caddy`, systemd service `caddy.service`) runs on Poseidon but is **NOT** in the public internet traffic path. It handles requests arriving directly at Poseidon (via Tailscale or LAN) and serves the Matrix `.well-known` discovery endpoints.

**Config:** `/etc/caddy/Caddyfile` (last modified 2026-03-03)

```
a-gis.org {
    handle /.well-known/matrix/server  → {"m.server":"matrix.a-gis.org:443"}
    handle /.well-known/matrix/client  → {"m.homeserver":{"base_url":"https://matrix.a-gis.org"}}
    handle                             → "a-gis.org" 200
}

matrix.a-gis.org {
    reverse_proxy localhost:6167        → conduwuit container (podman)
}
```

Caddy has no `s3.a-gis.org` block — s3 traffic is handled exclusively by NAS nginx. Do not add an s3 block to Caddy unless the traffic routing changes.

---

## Tailscale VPN

Tailscale provides a WireGuard-based mesh VPN across all machines regardless of subnet.

| Machine | Tailscale IP |
|---|---|
| Poseidon (Ubuntu) | `100.99.145.27` |
| Mount-Olympus (NAS) | `100.88.101.126` (confirmed — Portainer accessible at this addr; DSM package v1.58.2) |
| Portainer UI | `http://100.88.101.126:9000` (NAS Tailscale addr, confirmed) |

Tailscale is used for:
- Fleet bot access to NAS services
- Secure inter-machine communication
- Accessing Portainer and DSM without exposing to public internet

**Tailscale package on NAS:** v1.58.2-700058002 (installed via Synology Package Center)

---

## Docker Networks (on NAS)

Internal Docker networking on Mount-Olympus:

| Network | Driver | Subnet | Purpose |
|---|---|---|---|
| `bridge` | bridge | 172.17.0.0/16 | Docker default |
| `proxy` | bridge | 172.18.0.0/16 | Reverse-proxy-facing containers (gitea) |
| `ipfs_default` | bridge | 172.20.0.0/16 | IPFS compose stack |
| `host` | host | — | Host-mode containers |

---

## Open Issues

- [x] ~~Confirm Tailscale IP of Mount-Olympus~~ — `100.88.101.126` (confirmed; table updated)
- [x] ~~Verify s3.a-gis.org and matrix.a-gis.org routing~~ — NAS nginx confirmed as public entry point (2026-03-14)
- [ ] Remove SMB port forwards from Eero (security critical)
- [ ] Verify TLS cert renewal for all proxied subdomains (managed by NAS DSM, not Caddy)
- [ ] Document Eero admin access credentials location
- [ ] Confirm NAS nginx vhost config details (DSM → Login Portal → Advanced → Reverse Proxy — operator access needed)
