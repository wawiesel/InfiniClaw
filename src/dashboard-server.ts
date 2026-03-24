/**
 * Fleet Dashboard Server
 * Routes:
 *   /infiniclaw/fleet/ic01         — fleet home
 *   /infiniclaw/fleet/ic01/bazaar  — trading dashboard
 *   /infiniclaw/fleet/ic01/chart   — raw dashboard.png
 */
import fs from 'fs';
import http from 'http';
import path from 'path';

import { getSystemStatus } from './status.js';
import { resolveRoot } from './service.js';

const PORT = parseInt(process.env['FLEET_DASHBOARD_PORT'] || '3080', 10);
const BASE = '/infiniclaw/fleet/ic01';
const SIGNAL_DIR = path.join(resolveRoot(), 'bots/engineer/parker/signal');

// ── HTML helpers ───────────────────────────────────────────────────

function page(title: string, body: string, refreshSec?: number): string {
  const refresh = refreshSec ? `<meta http-equiv="refresh" content="${refreshSec}">` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${refresh}
<title>${title}</title>
<style>
  :root { --bg:#0d1117; --surface:#161b22; --border:#30363d; --text:#e6edf3; --muted:#8b949e; --green:#3fb950; --red:#f85149; --yellow:#d29922; --blue:#58a6ff; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font: 14px/1.5 'SF Mono', monospace; padding: 24px; }
  h1 { font-size: 18px; margin-bottom: 16px; color: var(--blue); }
  h2 { font-size: 14px; color: var(--muted); margin: 20px 0 8px; text-transform: uppercase; letter-spacing: .08em; }
  nav { margin-bottom: 24px; }
  nav a { color: var(--blue); text-decoration: none; margin-right: 16px; }
  nav a:hover { text-decoration: underline; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 16px; margin-bottom: 12px; }
  .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .badge { padding: 2px 8px; border-radius: 12px; font-size: 12px; }
  .ok { background: #1a3a1a; color: var(--green); }
  .warn { background: #3a2a0a; color: var(--yellow); }
  .err { background: #3a0a0a; color: var(--red); }
  .muted { color: var(--muted); font-size: 12px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; color: var(--muted); font-size: 12px; padding: 4px 8px; border-bottom: 1px solid var(--border); }
  td { padding: 6px 8px; border-bottom: 1px solid var(--border); }
  img { max-width: 100%; border-radius: 6px; }
  footer { margin-top: 24px; color: var(--muted); font-size: 12px; }
  .bot-cards { display: none; }
  .bot-card { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 12px; margin-bottom: 8px; }
  .bot-card .name { font-weight: bold; margin-bottom: 4px; }
  .bot-card .meta { display: flex; flex-wrap: wrap; gap: 8px; font-size: 12px; color: var(--muted); }
  @media (max-width: 600px) {
    body { padding: 12px; }
    table { display: none; }
    .bot-cards { display: block; }
    h1 { font-size: 16px; }
  }
</style>
</head>
<body>
<nav>
  <a href="${BASE}">ic01</a>
  <a href="${BASE}/bazaar">bazaar</a>
</nav>
<h1>${title}</h1>
${body}
<footer>${new Date().toISOString()}</footer>
</body>
</html>`;
}

function relTime(iso: string | undefined): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  return `${Math.floor(ms / 3600000)}h ago`;
}

// ── Pages ──────────────────────────────────────────────────────────

function fleetHome(): string {
  const status = getSystemStatus(resolveRoot());
  const rows = status.bots.map((b) => {
    const svc = b.service === 'running'
      ? '<span class="badge ok">running</span>'
      : '<span class="badge err">stopped</span>';
    const hb = b.heartbeatStale
      ? '<span class="badge warn">stale</span>'
      : b.lastHeartbeat ? relTime(b.lastHeartbeat) : '—';
    const errBadge = b.recentErrors.length > 0
      ? `<span class="badge err">${b.recentErrors.length} err</span>`
      : '';
    const tasks = b.tasks.filter(t => t.status === 'active').length;
    return `<tr>
      <td>${b.name}</td>
      <td>${svc}</td>
      <td>${b.model || '—'}</td>
      <td>${hb} ${errBadge}</td>
      <td>${b.containers.length}</td>
      <td>${tasks}</td>
    </tr>`;
  }).join('');

  const cards = status.bots.map((b) => {
    const svc = b.service === 'running'
      ? '<span class="badge ok">running</span>'
      : '<span class="badge err">stopped</span>';
    const hb = b.heartbeatStale
      ? '<span class="badge warn">stale</span>'
      : b.lastHeartbeat ? relTime(b.lastHeartbeat) : '—';
    const tasks = b.tasks.filter(t => t.status === 'active').length;
    return `<div class="bot-card">
      <div class="name">${b.name} ${svc}</div>
      <div class="meta">
        <span>${b.model || '—'}</span>
        <span>hb ${hb}</span>
        <span>${b.containers.length} containers</span>
        <span>${tasks} tasks</span>
        ${b.recentErrors.length > 0 ? `<span class="badge err">${b.recentErrors.length} err</span>` : ''}
      </div>
    </div>`;
  }).join('');

  const body = `
<div class="card">
  <table>
    <thead><tr><th>Bot</th><th>Service</th><th>Model</th><th>Heartbeat</th><th>Containers</th><th>Tasks</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>
<div class="bot-cards">${cards}</div>`;
  return page('IC01 Fleet', body, 30);
}

function bazaar(): string {
  const stateFile = path.join(SIGNAL_DIR, 'state.json');
  let signal = 'UNKNOWN', lastCheck = '', portfolio = '';
  let btcPrice = '', sma = '';

  if (fs.existsSync(stateFile)) {
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      signal = state.signal || 'UNKNOWN';
      lastCheck = state.last_check || '';
      const lastTrade = state.trades?.at(-1);
      if (lastTrade) {
        btcPrice = lastTrade.btc_price ? `$${lastTrade.btc_price.toLocaleString()}` : '';
      }
    } catch { /* ignore */ }
  }

  const signalClass = signal === 'BULL' ? 'ok' : signal === 'BEAR' ? 'err' : 'warn';
  const chartTime = Date.now();

  const body = `
<div class="card row">
  <span>Signal: <span class="badge ${signalClass}">${signal}</span></span>
  ${btcPrice ? `<span>BTC: <strong>${btcPrice}</strong></span>` : ''}
  ${lastCheck ? `<span class="muted">last run ${relTime(lastCheck)}</span>` : ''}
</div>
<div class="card">
  <img src="${BASE}/chart?t=${chartTime}" alt="BTC Dashboard">
</div>`;

  return page('Bazaar — Trading', body, 300);
}

// ── Request handler ────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url = req.url?.split('?')[0] || '';

  if (url === BASE || url === BASE + '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fleetHome());
    return;
  }

  if (url === `${BASE}/bazaar`) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(bazaar());
    return;
  }

  if (url === `${BASE}/chart`) {
    const img = path.join(SIGNAL_DIR, 'dashboard.png');
    if (fs.existsSync(img)) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
      fs.createReadStream(img).pipe(res);
    } else {
      res.writeHead(404);
      res.end('chart not found');
    }
    return;
  }

  res.writeHead(302, { Location: BASE });
  res.end();
});

server.listen(PORT, () => {
  console.log(`Fleet dashboard listening on :${PORT}`);
  console.log(`  ${BASE}`);
  console.log(`  ${BASE}/bazaar`);
});
