# 20 — Fleet Dashboard

Web UI for the IC01 fleet, hosted at `fleet.a-gis.org`.

## URL Structure

```
fleet.a-gis.org/infiniclaw/fleet/ic01           → fleet home (bot health, status)
fleet.a-gis.org/infiniclaw/fleet/ic01/bazaar    → trading dashboard (BTC signal, portfolio)
fleet.a-gis.org/infiniclaw/fleet/ic01/chart     → raw dashboard.png
```

## Architecture

A single lightweight Node.js HTTP server (`the dashboard server module`) runs on Poseidon via pm2, bound to port `3080`. The Synology NAS reverse proxy forwards `fleet.a-gis.org` to this server. DNS via Cloudflare, TLS via Let's Encrypt cert on the NAS.

```
Browser → fleet.a-gis.org (Cloudflare DNS → Synology NAS)
             └─ Reverse Proxy: fleet.a-gis.org:443 → http://192.168.6.149:3080
                  └─ dashboard-server.ts (pm2: infiniclaw-dashboard)
                       ├─ /infiniclaw/fleet/ic01         → fleet home
                       ├─ /infiniclaw/fleet/ic01/bazaar  → bazaar
                       └─ /infiniclaw/fleet/ic01/chart   → chart PNG
```

## Pages

### Fleet Home (`/infiniclaw/fleet/ic01`)

Shows IC01 fleet health pulled from `getSystemStatus()`:
- Each bot: name, model, service status, heartbeat age
- Container count
- Active task count
- Recent errors

Auto-refreshes every 30s via `<meta http-equiv="refresh">`.

### Bazaar (`/infiniclaw/fleet/ic01/bazaar`)

Trading dashboard:
- Embedded `dashboard.png` (latest BTC chart from strategy.py)
- Portfolio table: SOL, ETH, USDC values
- Signal state: BULL / BEAR + SMA delta
- Last run timestamp

Auto-refreshes every 5 minutes.

## Deployment

1. Build: `npm run build`
2. Start: `npx pm2 start dist/dashboard-server.js --name infiniclaw-dashboard`
3. Synology NAS reverse proxy: `fleet.a-gis.org:443 → http://192.168.6.149:3080`
4. DNS: Cloudflare A record `fleet.a-gis.org → 69.131.213.135`
5. TLS: Let's Encrypt cert on NAS (certbot DNS-01 via Cloudflare, uploaded to NAS via API)

## Port

`FLEET_DASHBOARD_PORT` env var, default `3080`.
