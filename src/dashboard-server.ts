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
import { loadKpiConfig, computeBotKpi, kpiBadge } from './kpi.js';
import { openTokenDb, insertTurnStart, completeTurn, insertCompletedTurns, queryUsage, queryAllUsage, queryInProgress, type UsageRow } from './token-store.js';
import { loadPricing } from './token-pricing.js';

const PORT = parseInt(process.env['FLEET_DASHBOARD_PORT'] || '3080', 10);
const tokenDataCache = new Map<string, { ts: number; data: string }>();
const REFRESH_MS = parseInt(process.env['FLEET_DASHBOARD_REFRESH_MS'] || '7000', 10);
const TIMEZONE = process.env['FLEET_DASHBOARD_TIMEZONE'] || 'America/New_York';
const MAX_STREAM_ROWS = parseInt(process.env['FLEET_DASHBOARD_MAX_STREAM_ROWS'] || '100', 10);
const FORCE_RENDER_MS = parseInt(process.env['FLEET_DASHBOARD_FORCE_RENDER_MS'] || '60000', 10);
const PLOT_GRANULARITY_S = parseInt(process.env['FLEET_DASHBOARD_GRANULARITY_S'] || '3', 10); // grn = uf/2, default 3s (uf=6s)
const BACKUP_INTERVAL_MS = parseInt(process.env['FLEET_DASHBOARD_BACKUP_INTERVAL_MS'] || String(24 * 3600_000), 10); // daily
const BACKUP_RETAIN = parseInt(process.env['FLEET_DASHBOARD_BACKUP_RETAIN'] || '30', 10);
const BASE = '/infiniclaw/fleet/ic01';

// ── Token livestream (SSE) ──────────────────────────────────────────
const sseClients = new Set<http.ServerResponse>();
const sseHistory: UsageRow[] = [];
const TOKEN_DB_DIR = path.join(process.cwd(), '_runtime', 'data');

// Initialize SQLite on startup
try { openTokenDb(TOKEN_DB_DIR); } catch (err) { console.error(`token-db: failed to open ${TOKEN_DB_DIR}: ${err}`); }

function broadcastSSE(rows: UsageRow[]): void {
  sseHistory.push(...rows);
  const data = JSON.stringify(rows);
  for (const client of sseClients) {
    try { client.write(`data: ${data}\n\n`); } catch { sseClients.delete(client); }
  }
}
const SIGNAL_DIR = path.join(resolveRoot(), 'bots/trader/parker/signal');

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
  const kpiConfig = loadKpiConfig(resolveRoot());

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
    const kpi = computeBotKpi(resolveRoot(), b.name, kpiConfig);
    return `<tr>
      <td>${b.name}</td>
      <td>${svc}</td>
      <td>${b.model || '—'}</td>
      <td>${hb} ${errBadge}</td>
      <td>${kpiBadge(kpi)}</td>
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
    const kpi = computeBotKpi(resolveRoot(), b.name, kpiConfig);
    return `<div class="bot-card">
      <div class="name">${b.name} ${svc}</div>
      <div class="meta">
        <span>${b.model || '—'}</span>
        <span>hb ${hb}</span>
        <span>kpi ${kpiBadge(kpi)}</span>
        <span>${b.containers.length} containers</span>
        <span>${tasks} tasks</span>
        ${b.recentErrors.length > 0 ? `<span class="badge err">${b.recentErrors.length} err</span>` : ''}
      </div>
    </div>`;
  }).join('');

  const body = `
<div class="card">
  <table>
    <thead><tr><th>Bot</th><th>Service</th><th>Model</th><th>Heartbeat</th><th>KPI</th><th>Containers</th><th>Tasks</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>
<div class="bot-cards">${cards}</div>`;
  return page('IC01 Fleet', body, 30);
}

function bazaar(): string {
  const stateFile   = path.join(SIGNAL_DIR, 'state.json');
  const modelFile   = path.join(SIGNAL_DIR, 'model_state.json');
  const priceFile   = path.join(SIGNAL_DIR, 'price_data.json');

  let signal = 'UNKNOWN', lastCheck = '';
  let btcPriceLive = 0, solPriceLive = 0, ethPriceLive = 0, smaLive = 0, totalLive = 0;
  let trades: Array<Record<string, unknown>> = [];
  let predictions: Array<Record<string, unknown>> = [];
  let weights: Record<string, number> = {};
  let runs = 0;
  let btcHistory: number[] = [], solHistory: number[] = [], ethHistory: number[] = [];
  let priceUpdated = '';

  if (fs.existsSync(stateFile)) {
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      signal    = state.signal || 'UNKNOWN';
      lastCheck = state.last_check || '';
      trades    = state.trades || [];
    } catch { /* ignore */ }
  }

  if (fs.existsSync(modelFile)) {
    try {
      const model = JSON.parse(fs.readFileSync(modelFile, 'utf8'));
      predictions = model.predictions || [];
      weights     = model.weights || {};
      runs        = model.runs || 0;
    } catch { /* ignore */ }
  }

  if (fs.existsSync(priceFile)) {
    try {
      const pd = JSON.parse(fs.readFileSync(priceFile, 'utf8'));
      btcHistory   = pd.btc || [];
      solHistory   = pd.sol || [];
      ethHistory   = pd.eth || [];
      btcPriceLive = pd.btc_price || 0;
      solPriceLive = pd.sol_price || 0;
      ethPriceLive = pd.eth_price || 0;
      smaLive      = pd.sma || 0;
      totalLive    = pd.total || 0;
      priceUpdated = pd.updated || '';
    } catch { /* ignore */ }
  }

  // Accuracy stats
  function accStats(asset: string) {
    const v3 = predictions.filter(p => p['asset'] === asset && p['actual_24h'] != null && p['model_v'] === 3);
    const v2 = predictions.filter(p => p['asset'] === asset && p['actual_24h'] != null && p['model_v'] === 2);
    const use = v3.length ? v3 : v2;
    const mv  = v3.length ? 3 : 2;
    if (!use.length) return { dir: '—', mape: '—', n: 0, mv };
    const dir  = Math.round(use.filter(p => p['dir_correct']).length / use.length * 100);
    const mape = (use.reduce((s, p) => s + Number(p['pct_error'] || 0), 0) / use.length).toFixed(1);
    return { dir: `${dir}%`, mape: `${mape}%`, n: use.length, mv };
  }
  const solAcc = accStats('SOL');
  const ethAcc = accStats('ETH');

  const signalClass  = signal === 'BULL' ? 'ok' : signal === 'BEAR' ? 'err' : 'warn';
  const pctSma       = smaLive ? ((btcPriceLive - smaLive) / smaLive * 100).toFixed(1) : '—';
  const btcFmt       = btcPriceLive ? `$${Math.round(btcPriceLive).toLocaleString()}` : '—';
  const smaFmt       = smaLive ? `$${Math.round(smaLive).toLocaleString()}` : '—';
  const solDir       = typeof solAcc.dir === 'string' && solAcc.dir !== '—'
    ? parseInt(solAcc.dir) >= 50 ? 'green' : parseInt(solAcc.dir) < 40 ? 'red' : 'yellow' : 'muted';
  const ethDir       = typeof ethAcc.dir === 'string' && ethAcc.dir !== '—'
    ? parseInt(ethAcc.dir) >= 50 ? 'green' : parseInt(ethAcc.dir) < 40 ? 'red' : 'yellow' : 'muted';

  const tradesJson  = JSON.stringify(trades);
  const predsJson   = JSON.stringify(predictions);
  const btcJson     = JSON.stringify(btcHistory);
  const solJson     = JSON.stringify(solHistory);
  const ethJson     = JSON.stringify(ethHistory);

  // ── Read additional state fields written by strategy.py ──────────
  let portfolioTotal = 0, btcPriceSnap = 0, initialDeposit = 0, alpacaEquity = 0;
  if (fs.existsSync(stateFile)) {
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      portfolioTotal = state.portfolio_total || totalLive || 0;
      btcPriceSnap   = state.btc_price || btcPriceLive || 0;
      initialDeposit = state.initial || 83.93;
    } catch { /* ignore */ }
  }
  const alpacaFile = path.join(SIGNAL_DIR, 'alpaca_state.json');
  if (fs.existsSync(alpacaFile)) {
    try {
      const as = JSON.parse(fs.readFileSync(alpacaFile, 'utf8'));
      alpacaEquity = as.portfolio_value || 0;
    } catch { /* ignore */ }
  }
  const pnl      = portfolioTotal - initialDeposit;
  const pnlSign  = pnl >= 0 ? '+' : '';
  const pnlColor = pnl >= 0 ? 'var(--green)' : 'var(--red)';
  const sigColor = signal === 'BULL' ? 'var(--green)' : 'var(--red)';
  const sigBg    = signal === 'BULL' ? '#0d2818' : '#2d0d0d';
  const btcDisplay = (btcPriceSnap || btcPriceLive) ? `$${Math.round(btcPriceSnap || btcPriceLive).toLocaleString()}` : '—';

  // Overall weighted accuracy (simple count-based for TS)
  function overallAcc() {
    const all = predictions.filter(p => p['actual_24h'] != null);
    if (!all.length) return '—';
    return Math.round(all.filter(p => p['dir_correct']).length / all.length * 100) + '%';
  }

  const body = `
<style>
  .cmd-strip { display:grid; grid-template-columns:1fr 1fr 1fr; gap:12px; margin-bottom:20px; }
  .tile { border-radius:10px; padding:18px 14px; text-align:center; border:2px solid #30363d; }
  .tile .tlabel { font-size:10px; color:#8b949e; text-transform:uppercase; letter-spacing:.08em; margin-bottom:8px; }
  .tile .tbig { font-size:2.2rem; font-weight:800; line-height:1; margin-bottom:8px; }
  .tile .tsub1 { font-size:0.88rem; color:#c9d1d9; margin-bottom:3px; }
  .tile .tsub2 { font-size:0.75rem; color:#8b949e; }
  @media(max-width:600px){ .cmd-strip{ grid-template-columns:1fr; } .tile .tbig{ font-size:1.7rem; } }
</style>

<div class="cmd-strip">
  <div class="tile" style="background:${sigBg};border-color:${sigColor}">
    <div class="tlabel">Market Signal</div>
    <div class="tbig" style="color:${sigColor}">${signal}</div>
    <div class="tsub1">BTC ${btcDisplay} &nbsp; ${pctSma !== '—' ? (signal==='BULL'?'+':'')+pctSma+'% SMA' : ''}</div>
    <div class="tsub2">SMA-50 ${smaFmt} · run #${runs} · ${lastCheck ? relTime(lastCheck) : '—'}</div>
  </div>
  <div class="tile" style="background:#0d1a2d;border-color:#ffd93d">
    <div class="tlabel">Total Portfolio</div>
    <div class="tbig" style="color:#ffd93d">P&amp;L ${pnlSign}$${Math.abs(pnl).toFixed(2)}</div>
    <div class="tsub1">Crypto $${(portfolioTotal||totalLive||0).toFixed(0)}</div>
    <div class="tsub2">BTC · SOL · ETH · USDC</div>
  </div>
  <div class="tile" style="background:#0d1a2d;border-color:#00e5ff">
    <div class="tlabel">Algorithm Score</div>
    <div class="tbig" style="color:#00e5ff">${overallAcc()}</div>
    <div class="tsub1">SOL <strong style="color:var(--${solDir})">${solAcc.dir}</strong> &nbsp; ETH <strong style="color:var(--${ethDir})">${ethAcc.dir}</strong></div>
    <div class="tsub2">move-weighted directional · ${predictions.filter(p=>p['actual_24h']!=null).length} scored</div>
  </div>
</div>

<div class="card">
  <h2>BTC Price vs 50-Day SMA (120 days)</h2>
  <canvas id="btcChart" height="200"></canvas>
</div>

<div class="card">
  <h2>Portfolio Value</h2>
  <canvas id="portfolioChart" height="180"></canvas>
</div>

<div class="card">
  <h2>Price Predictions — P10/P90 Confidence Bands</h2>
  <div class="row" style="margin-bottom:8px;gap:8px">
    <button class="asset-btn" data-asset="ETH" style="background:var(--surface);color:var(--blue);border:1px solid var(--border);border-radius:4px;padding:4px 12px;cursor:pointer;font-size:13px">ETH</button>
    <button class="asset-btn" data-asset="SOL" style="background:var(--surface);color:var(--blue);border:1px solid var(--border);border-radius:4px;padding:4px 12px;cursor:pointer;font-size:13px">SOL</button>
  </div>
  <canvas id="predChart" height="250"></canvas>
</div>

<div class="card">
  <h2>SOL vs ETH Price (120 days)</h2>
  <div class="row" style="margin-bottom:8px;gap:8px">
    <button class="hist-btn" data-asset="SOL" style="background:var(--surface);color:var(--blue);border:1px solid var(--border);border-radius:4px;padding:4px 12px;cursor:pointer;font-size:13px">SOL</button>
    <button class="hist-btn" data-asset="ETH" style="background:var(--surface);color:var(--blue);border:1px solid var(--border);border-radius:4px;padding:4px 12px;cursor:pointer;font-size:13px">ETH</button>
    <button class="hist-btn" data-asset="BOTH" style="background:var(--blue);color:#0d1117;border:1px solid var(--border);border-radius:4px;padding:4px 12px;cursor:pointer;font-size:13px">Both</button>
  </div>
  <canvas id="altChart" height="200"></canvas>
</div>

<div class="card">
  <h2>Dashboard Chart (Equity Curve + Forecast)</h2>
  <img src="${BASE}/chart?t=${Date.now()}" style="width:100%;border-radius:4px" alt="dashboard">
</div>

<div class="card">
  <h2>Trade History</h2>
  <div id="tradeList" style="max-height:300px;overflow-y:auto"></div>
</div>

<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3/dist/chartjs-adapter-date-fns.bundle.min.js"></script>
<script>
const trades = ${tradesJson};
const predictions = ${predsJson};
const btcHistory = ${btcJson};
const solHistory = ${solJson};
const ethHistory = ${ethJson};
const C = { green:'#3fb950', red:'#f85149', blue:'58a6ff', orange:'#f0883e',
            purple:'#a371f7', muted:'#8b949e', yellow:'#d29922', teal:'#00e5ff' };
const gridColor = '#30363d', tickColor = '#8b949e';
const scaleOpts = (cb) => ({
  x: { type:'time', grid:{color:gridColor}, ticks:{color:tickColor,maxTicksLimit:8} },
  y: { grid:{color:gridColor}, ticks:{color:tickColor, callback: cb || (v => '$'+Number(v).toFixed(0)) } }
});

// ── BTC + SMA chart ───────────────────────────────────────────────
if (btcHistory.length > 10) {
  const period = 50;
  const n = btcHistory.length;
  const now = Date.now();
  const msPerDay = 86400000;
  const btcLabels = btcHistory.map((_, i) => new Date(now - (n - 1 - i) * msPerDay));
  const sma50 = btcHistory.map((_, i) => {
    const slice = btcHistory.slice(Math.max(0, i - period + 1), i + 1);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });
  const bullBg = btcHistory.map((p, i) => p > sma50[i] ? '#3fb95015' : '#f8514915');
  new Chart(document.getElementById('btcChart'), {
    type: 'line',
    data: {
      labels: btcLabels,
      datasets: [
        { label:'BTC', data:btcHistory, borderColor:'#f0883e', borderWidth:2, pointRadius:0, tension:0.2 },
        { label:'SMA50', data:sma50, borderColor:'#00e5ff', borderWidth:1.5, borderDash:[6,3], pointRadius:0 },
      ]
    },
    options: {
      responsive:true, interaction:{mode:'index',intersect:false},
      plugins:{ legend:{labels:{color:tickColor}} },
      scales: scaleOpts()
    }
  });
}

// ── Portfolio chart ───────────────────────────────────────────────
if (trades.length) {
  new Chart(document.getElementById('portfolioChart'), {
    type: 'line',
    data: {
      labels: trades.map(t => new Date(t.timestamp)),
      datasets: [{
        label:'Portfolio $', data:trades.map(t => t.portfolio_value),
        borderColor:'#58a6ff', backgroundColor:'#58a6ff20', fill:true, tension:0.3,
        pointRadius:6,
        pointBackgroundColor: trades.map(t =>
          t.action==='BUY_FROM_USDC'||t.action==='AUTO_DEPLOY' ? C.green : C.red),
        pointBorderColor:'#0d1117', pointBorderWidth:1,
      }]
    },
    options: {
      responsive:true, interaction:{mode:'nearest',intersect:false},
      plugins:{ legend:{display:false},
        tooltip:{ callbacks:{
          title: items => new Date(trades[items[0].dataIndex].timestamp).toLocaleString(),
          afterLabel: item => trades[item.dataIndex].action
        }}
      },
      scales: scaleOpts(v => '$'+Number(v).toFixed(2))
    }
  });
}

// ── Prediction chart ──────────────────────────────────────────────
let predChart;
function showPredictions(asset) {
  const data = predictions.filter(p => p.asset === asset && p.price_at_pred);
  if (predChart) predChart.destroy();
  const labels = data.map(p => new Date(p.timestamp * 1000));
  predChart = new Chart(document.getElementById('predChart'), {
    type:'line',
    data:{
      labels,
      datasets:[
        { label:'Price', data:data.map(p=>p.price_at_pred), borderColor:'#58a6ff', borderWidth:2, pointRadius:0 },
        { label:'Predicted 24h', data:data.map(p=>p.pred_24h), borderColor:C.yellow, borderWidth:2, borderDash:[5,3], pointRadius:0 },
        { label:'Actual 24h', data:data.map(p=>p.actual_24h),
          borderColor: C.green, borderWidth:2,
          pointRadius: data.map(p => p.actual_24h != null ? 4 : 0),
          pointBackgroundColor: data.map(p => p.dir_correct ? C.green : C.red),
          pointBorderColor:'#0d1117', pointBorderWidth:1 },
        { label:'P90', data:data.map(p=>p.pred_p90), borderColor:'transparent', backgroundColor:C.muted+'18', fill:'+1', pointRadius:0 },
        { label:'P10', data:data.map(p=>p.pred_p10), borderColor:'transparent', pointRadius:0 },
      ]
    },
    options:{
      responsive:true, interaction:{mode:'index',intersect:false},
      plugins:{ legend:{labels:{color:tickColor}},
        tooltip:{callbacks:{ title:items=>labels[items[0].dataIndex].toLocaleString() }}
      },
      scales: scaleOpts()
    }
  });
  document.querySelectorAll('.asset-btn').forEach(b => {
    b.style.background = b.dataset.asset===asset ? '#58a6ff' : 'var(--surface)';
    b.style.color = b.dataset.asset===asset ? '#0d1117' : '#58a6ff';
  });
}
document.querySelectorAll('.asset-btn').forEach(b =>
  b.addEventListener('click', () => showPredictions(b.dataset.asset)));
showPredictions('ETH');

// ── SOL/ETH history chart ─────────────────────────────────────────
let altChart;
function showAlt(asset) {
  if (altChart) altChart.destroy();
  const n = Math.max(solHistory.length, ethHistory.length);
  const now = Date.now();
  const labels = Array.from({length:n}, (_, i) => new Date(now - (n-1-i)*86400000));
  const datasets = [];
  if (asset==='SOL'||asset==='BOTH')
    datasets.push({ label:'SOL', data:solHistory, borderColor:'#a371f7', borderWidth:2, pointRadius:0, tension:0.2 });
  if (asset==='ETH'||asset==='BOTH')
    datasets.push({ label:'ETH', data:ethHistory, borderColor:'#f0883e', borderWidth:2, pointRadius:0, tension:0.2,
      yAxisID: asset==='BOTH' ? 'y2' : 'y' });
  const scalesConf = { x:{type:'time',grid:{color:gridColor},ticks:{color:tickColor,maxTicksLimit:8}},
    y:{grid:{color:gridColor},ticks:{color:tickColor,callback:v=>'$'+Number(v).toFixed(2)}} };
  if (asset==='BOTH') scalesConf['y2'] = {position:'right',grid:{drawOnChartArea:false},ticks:{color:'#f0883e',callback:v=>'$'+Number(v).toFixed(0)}};
  altChart = new Chart(document.getElementById('altChart'), {
    type:'line', data:{labels,datasets},
    options:{ responsive:true, interaction:{mode:'index',intersect:false},
      plugins:{legend:{labels:{color:tickColor}}}, scales:scalesConf }
  });
  document.querySelectorAll('.hist-btn').forEach(b => {
    b.style.background = b.dataset.asset===asset ? '#58a6ff' : 'var(--surface)';
    b.style.color = b.dataset.asset===asset ? '#0d1117' : '#58a6ff';
  });
}
document.querySelectorAll('.hist-btn').forEach(b =>
  b.addEventListener('click', () => showAlt(b.dataset.asset)));
showAlt('BOTH');

// ── Trade list ────────────────────────────────────────────────────
document.getElementById('tradeList').innerHTML = [...trades].reverse().map(t => {
  const isBuy = t.action==='BUY_FROM_USDC'||t.action==='AUTO_DEPLOY';
  const color = isBuy ? C.green : C.red;
  return '<div style="padding:8px 0;border-bottom:1px solid #30363d;font-size:13px">' +
    '<span style="color:'+color+'">'+(isBuy?'▲':'▼')+' '+t.action+'</span>' +
    '<span class="muted" style="float:right">'+new Date(t.timestamp).toLocaleString()+'</span><br>' +
    '<span class="muted">BTC $'+(t.btc_price||0).toLocaleString()+
    ' &middot; Portfolio $'+(t.portfolio_value||0).toFixed(2)+'</span></div>';
}).join('');
</script>`;

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
    const htmlFile = path.join(SIGNAL_DIR, 'dashboard.html');
    if (fs.existsSync(htmlFile)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      fs.createReadStream(htmlFile).pipe(res);
    } else {
      res.writeHead(404);
      res.end('dashboard.html not found in signal dir');
    }
    return;
  }

  // Serve JSON data files from SIGNAL_DIR for the dashboard's fetch() calls
  const JSON_FILES = ['state.json', 'model_state.json', 'alpaca_state.json', 'price_data.json'];
  const fileName = url.replace(`${BASE}/`, '');
  if (JSON_FILES.includes(fileName)) {
    const dataFile = path.join(SIGNAL_DIR, fileName);
    if (fs.existsSync(dataFile)) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      fs.createReadStream(dataFile).pipe(res);
    } else {
      res.writeHead(404);
      res.end('not found');
    }
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

  // ── Token ingest endpoint — relays POST usage rows here ──
  if (url === `${BASE}/tokens/ingest` && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const rows = JSON.parse(body) as UsageRow[];
        if (!Array.isArray(rows) || rows.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{"error":"expected non-empty array"}');
          return;
        }
        try { openTokenDb(TOKEN_DB_DIR); } catch (err) { console.error(`token-db: ingest open failed: ${err}`); }
        let count = 0;
        const enriched: UsageRow[] = [];
        for (const r of rows) {
          // Skip zero-duration turns (tool calls within same second)
          if (r.t_start && r.t_end && r.t_start === r.t_end) continue;
          if (r.t_end) {
            if (r.turn_id && completeTurn(r.turn_id, { t_end: r.t_end, input_tokens: r.input_tokens || 0, output_tokens: r.output_tokens || 0, cache_write_tokens: r.cache_write_tokens || 0, cache_read_tokens: r.cache_read_tokens || 0 })) {
              count++;
              // Query full row from DB for broadcast
              const full = queryUsage(r.bot || '', undefined).find(row => row.turn_id === r.turn_id);
              if (full) enriched.push(full);
            } else {
              count += insertCompletedTurns([r as UsageRow]);
              enriched.push(r as UsageRow);
            }
          } else {
            insertTurnStart(r as UsageRow);
            count++;
            enriched.push({ ...r, event: 'start' } as unknown as UsageRow);
          }
        }
        broadcastSSE(enriched.length > 0 ? enriched : rows);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ inserted: count }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
    return;
  }

  // ── Token stream clear — resets SSE history ──
  if (url === `${BASE}/tokens/stream/clear` && req.method === 'POST') {
    sseHistory.length = 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"cleared":true}');
    return;
  }

  // ── Token SSE stream — browser connects for live updates ──
  if (url === `${BASE}/tokens/stream`) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(':ok\n\n');
    // Send all events since server start
    if (sseHistory.length > 0) {
      const sorted = [...sseHistory].sort((a, b) => (a.t_end || a.t_start || '').localeCompare(b.t_end || b.t_start || ''));
      res.write(`data: ${JSON.stringify(sorted)}\n\n`);
    }
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // Token usage dashboard — served from HTML file with template substitution
  if (url === `${BASE}/tokens`) {
    const testMode = (req.url || '').includes('test=');
    const htmlPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'token-dashboard.html');
    try {
      let html = fs.readFileSync(htmlPath, 'utf-8');
      html = html.replace(/__BASE__/g, BASE);
      html = html.replace(/__TEST_MODE__/g, String(testMode));
      html = html.replace(/__TITLE_SUFFIX__/g, testMode ? '(TEST)' : '');
      html = html.replace(/__REFRESH_MS__/g, String(REFRESH_MS));
      html = html.replace(/__TIMEZONE__/g, TIMEZONE);
      html = html.replace(/__MAX_STREAM_ROWS__/g, String(MAX_STREAM_ROWS));
      html = html.replace(/__FORCE_RENDER_MS__/g, String(FORCE_RENDER_MS));
      html = html.replace(/__GRANULARITY_S__/g, String(PLOT_GRANULARITY_S));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(html);
    } catch {
      // Fallback to old inline version if HTML file not found
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(tokenDashboardPage(testMode));
    }
    return;
  }

  if (url === `${BASE}/tokens/data.json`) {
    // Serve from local SQLite — fast, no S3 round-trips
    void (async () => { try {
      const { MODEL_PRICING } = await import('./token-pricing.js');
      const { loadFleet, loadShips } = await import('./ship-config.js');
      const fleet = loadFleet();
      const ships = loadShips();
      const hostToShip: Record<string, string> = {};
      for (const [abbr, info] of Object.entries(ships)) {
        const s = info as { hostname?: string; type?: string };
        if (s.hostname && s.type !== 'testbed') hostToShip[s.hostname] = abbr;
      }
      try { openTokenDb(TOKEN_DB_DIR); } catch (err) { console.error(`token-db: data.json open failed: ${err}`); }
      const allRows = queryAllUsage();
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600_000).getTime();
      const result: Record<string, unknown> = {};
      // Group rows by bot
      const byBot: Record<string, typeof allRows> = {};
      for (const r of allRows) { if (!byBot[r.bot]) byBot[r.bot] = []; byBot[r.bot].push(r); }
      // Include all fleet bots even if no data
      for (const bot of Object.keys(fleet)) {
        const botInfo = fleet[bot] as { ship?: string; role?: string };
        const shipAbbr = hostToShip[botInfo?.ship || ''] || botInfo?.ship || 'Unknown';
        const rows = byBot[bot] || [];
        // cost = sum_k[ tokens_{bsxk} * C_{bsxk} ] where C_{bsxk} = price_per_token for model l(b,s,x), token type k
        const entries = rows.map(r => ({
          ...r,
          cost: r.input_tokens * r.input_price_per_token + r.output_tokens * r.output_price_per_token + r.cache_write_tokens * r.cache_write_price_per_token + r.cache_read_tokens * r.cache_read_price_per_token,
        }));
        // Aggregate by model — 7-day rolling totals for tables
        const agg: Record<string, { input: number; output: number; cache_write: number; cache_read: number; total: number; cost: number }> = {};
        for (const e of entries) {
          if (new Date(e.t_end || e.t_start).getTime() < sevenDaysAgo) continue;
          const k = `${e.provider}/${e.model}`;
          if (!agg[k]) agg[k] = { input: 0, output: 0, cache_write: 0, cache_read: 0, total: 0, cost: 0 };
          agg[k].input += e.input_tokens; agg[k].output += e.output_tokens;
          agg[k].cache_write += e.cache_write_tokens; agg[k].cache_read += e.cache_read_tokens;
          agg[k].total += e.input_tokens + e.output_tokens + e.cache_write_tokens;
          agg[k].cost += e.cost;
        }
        result[bot] = { entries, aggregate: agg, ship: shipAbbr, role: botInfo?.role || 'unknown' };
      }
      (result as Record<string, unknown>)._pricing = MODEL_PRICING;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: String(err) }));
    } })();
    return;
  }

  res.writeHead(302, { Location: BASE });
  res.end();
});

// ── Token Dashboard ──────────────────────────────────────────────────

function tokenDashboardPage(testMode: boolean): string {
  // NEW hierarchical dashboard — replaces previous implementation
  const script = `
<script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script>
<style>
  .tab-bar { display:flex; gap:0; margin-bottom:-1px; position:relative; z-index:1; }
  .tab-btn { padding:6px 16px; background:var(--bg); border:1px solid var(--border); border-bottom:none;
    color:var(--muted); cursor:pointer; font:12px/1.5 inherit; border-radius:6px 6px 0 0; }
  .tab-btn.active { background:var(--surface); color:var(--blue); border-bottom:1px solid var(--surface); }
</style>
<script>
const MC = {'claude-sonnet-4-6':'#58a6ff','claude-opus-4-6':'#bc8cff','qwen3:14b':'#3fb950','qwen3:30b':'#2ea043'};
const DC = '#8b949e';
const TEST = ${testMode};

function testData() {
  const now = Date.now(), entries = [];
  const M = [{m:'claude-sonnet-4-6',p:'anthropic'},{m:'qwen3:14b',p:'ollama'},{m:'claude-opus-4-6',p:'anthropic'}];
  for (let i=0;i<120;i++) {
    const h=i*0.4, mi=h>32?0:h>16?1:2;
    const b=200+Math.random()*800+(mi===2?400:0);
    const inp=Math.floor(b*.6),out=Math.floor(b*.3),cch=Math.floor(b*.1);
    // Pricing: sonnet=$3/$15, qwen=free, opus=$15/$75 per M tokens
    const prices = {0:[3,15],1:[0,0],2:[15,75]};
    const cost = (inp*prices[mi][0]+out*prices[mi][1]+cch*0.375)/1e6;
    entries.push({timestamp:new Date(now-h*3600000).toISOString(),model:M[mi].m,provider:M[mi].p,
      input_tokens:inp,output_tokens:out,cache_tokens:cch,cost});
  }
  return {parker:{entries,aggregate:{'anthropic/claude-sonnet-4-6':{input:28000,output:14000,cache:4000,total:46000,cost:0.30},
    'ollama/qwen3:14b':{input:12000,output:6000,cache:0,total:18000,cost:0},'anthropic/claude-opus-4-6':{input:20000,output:10000,cache:5000,total:35000,cost:1.05}}}};
}

function process(entries, field) {
  // field: 'total'|'input'|'output'|'cache'|'cost'
  const now = Date.now();
  const sorted = entries.slice().sort((a,b) => new Date(a.timestamp)-new Date(b.timestamp));
  if (sorted.length<2) return {cum:[],rate:[]};
  let cumSum=0;
  const pts = sorted.map(e => {
    let v;
    if (field==='cost') v=e.cost||0;
    else if (field==='input') v=e.input_tokens||0;
    else if (field==='output') v=e.output_tokens||0;
    else if (field==='cache') v=e.cache_tokens||0;
    else v=(e.input_tokens||0)+(e.output_tokens||0)+(e.cache_tokens||0);
    cumSum+=v;
    const hoursAgo = Math.max(0.01, (now-new Date(e.timestamp).getTime())/3600000);
    return {hoursAgo, cum:cumSum, model:e.model||'unknown', date:new Date(e.timestamp)};
  });
  const rate = pts.map((p,i) => {
    const prev=pts[Math.max(0,i-1)], next=pts[Math.min(pts.length-1,i+1)];
    const dt=(next.date-prev.date)/3600000;
    const dy=next.cum-prev.cum;
    return {...p, rate:dt>0?dy/dt:0};
  });
  return {cum:pts, rate};
}

// Midnight markers for date labels on x-axis
function midnightAnnotations(maxHoursAgo) {
  const now = new Date();
  const annotations = [];
  // EST offset (-5 or -4 for EDT)
  const estOff = -5;
  for (let d=0; d<Math.ceil(maxHoursAgo/24)+1; d++) {
    const midnight = new Date(now);
    midnight.setUTCHours(-estOff, 0, 0, 0); // midnight EST in UTC
    midnight.setUTCDate(midnight.getUTCDate() - d);
    const hAgo = (now - midnight) / 3600000;
    if (hAgo > 0 && hAgo < maxHoursAgo) {
      const label = midnight.toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'America/New_York'});
      annotations.push({x:Math.log10(hAgo),y:0,xref:'x',yref:'paper',text:label,showarrow:false,
        font:{size:9,color:'#6e7681'},yanchor:'top',yshift:8});
    }
  }
  return annotations;
}

// Build model-colored segments for a single continuous line
function modelSegments(pts, yKey) {
  const traces=[];
  let s=0;
  for (let i=1;i<=pts.length;i++) {
    if (i===pts.length||pts[i].model!==pts[s].model) {
      const seg=pts.slice(s, Math.min(i+1,pts.length));
      traces.push({
        x:seg.map(p=>p.hoursAgo), y:seg.map(p=>Math.round(p[yKey])),
        customdata:seg.map(p=>p.date.toISOString().slice(0,16).replace('T',' ')),
        type:'scatter', mode:'lines+markers',
        line:{color:MC[pts[s].model]||DC, width:2.5, shape:'spline'},
        marker:{size:4, color:MC[pts[s].model]||DC},
        name:pts[s].model, showlegend:false,
        hovertemplate:'%{customdata}<br>'+pts[s].model+': %{y:,.0f}<extra></extra>'
      });
      s=i;
    }
  }
  return traces;
}

function fmtAgo(h) {
  if (h<1) return Math.round(h*60)+'m ago';
  if (h<24) return Math.round(h)+'h ago';
  return (h/24).toFixed(1)+'d ago';
}

async function load() {
  const data = TEST ? testData() : await fetch('${BASE}/tokens/data.json').then(r=>r.json());
  const bots = Object.keys(data);
  if (!bots.length) { document.getElementById('content').innerHTML='<p>No data.</p>'; return; }

  let html='';
  const VIEWS = ['total','input','output','cache'];
  for (const bot of bots) {
    // Tabs: Rate/Cumulative × Total/Input/Output/Cache
    html+='<div class="tab-bar">';
    html+='<button class="tab-btn active" onclick="switchView(\\''+bot+'\\',\\'rate\\',\\'total\\',this)">Total Rate</button>';
    html+='<button class="tab-btn" onclick="switchView(\\''+bot+'\\',\\'cum\\',\\'total\\',this)">Total Cumulative</button>';
    html+='<button class="tab-btn" onclick="switchView(\\''+bot+'\\',\\'rate\\',\\'input\\',this)">Input</button>';
    html+='<button class="tab-btn" onclick="switchView(\\''+bot+'\\',\\'rate\\',\\'output\\',this)">Output</button>';
    html+='<button class="tab-btn" onclick="switchView(\\''+bot+'\\',\\'rate\\',\\'cache\\',this)">Cache</button>';
    html+='<button class="tab-btn" onclick="switchView(\\''+bot+'\\',\\'rate\\',\\'cost\\',this)">$/hr</button>';
    html+='<button class="tab-btn" onclick="switchView(\\''+bot+'\\',\\'cum\\',\\'cost\\',this)">$ Cumulative</button>';
    html+='</div>';
    html+='<div id="plot-'+bot+'" class="card" style="margin-top:0;border-top-left-radius:0"></div>';
    // Table BELOW chart
    const d=data[bot];
    if (d.aggregate && Object.keys(d.aggregate).length) {
      html+='<h2>'+bot+' — 7d totals</h2><table style="width:auto"><tr><th>Model</th><th>Input</th><th>Output</th><th>Cache</th><th>Total</th><th>tok/hr</th><th>Cost (7d)</th><th>$/hr</th></tr>';
      for (const [m,v] of Object.entries(d.aggregate)) {
        const rate = Math.round(v.total / (7*24));
        const cost = v.cost != null ? '$'+v.cost.toFixed(2) : '—';
        const costRate = v.cost != null ? '$'+(v.cost/(7*24)).toFixed(4) : '—';
        html+='<tr><td>'+m+'</td><td>'+v.input.toLocaleString()+'</td><td>'+v.output.toLocaleString()+'</td><td>'+v.cache.toLocaleString()+'</td><td>'+v.total.toLocaleString()+'</td><td>'+rate.toLocaleString()+'</td><td>'+cost+'</td><td>'+costRate+'</td></tr>';
      }
      html+='</table>';
    }
  }
  // Legend
  html+='<div style="margin:12px 0;display:flex;gap:16px;flex-wrap:wrap">';
  for (const [m,c] of Object.entries(MC))
    html+='<span style="display:flex;align-items:center;gap:4px"><span style="width:14px;height:3px;background:'+c+'"></span><span class="muted">'+m+'</span></span>';
  html+='</div>';
  document.getElementById('content').innerHTML=html;

  // Log tick values for the x-axis
  const ticks=[0.05,0.1,0.25,0.5,1,2,4,8,12,24,48];
  const tickTexts=ticks.map(fmtAgo);

  for (const bot of bots) {
    const entries=data[bot].entries||[];
    if (!entries.length) continue;

    // Store entries on div for view switching
    const div=document.getElementById('plot-'+bot);
    div._entries=entries;
    div._allData=data[bot];
    renderPlot(bot,'rate','total');
  }
}

function renderPlot(bot, mode, field) {
  const div=document.getElementById('plot-'+bot);
  if (!div||!div._entries) return;
  const {cum,rate}=process(div._entries, field);
  if (!rate.length) return;

  const ticks=[0.05,0.1,0.25,0.5,1,2,4,8,12,24,48];
  const tickTexts=ticks.map(fmtAgo);
  const pts = mode==='cum' ? cum : rate;
  const yKey = mode==='cum' ? 'cum' : 'rate';
  const isCost = field==='cost';
  const unit = isCost ? '$' : 'tokens';
  const yTitle = mode==='cum' ? (isCost?'$ cumulative':field+' tokens (cumulative)') : (isCost?'$/hr':field+' tokens/hr');
  const traces = modelSegments(pts, yKey);
  const maxH = pts.length ? Math.max(...pts.map(p=>p.hoursAgo)) : 48;
  const annots = midnightAnnotations(maxH);

  const layout = {
    paper_bgcolor:'#161b22', plot_bgcolor:'#0d1117',
    font:{color:'#8b949e',size:11},
    xaxis:{type:'log',autorange:'reversed',gridcolor:'#21262d',linecolor:'#30363d',
      tickvals:ticks,ticktext:tickTexts,title:{text:'\\u2190 past \\u00b7 now \\u2192'}},
    yaxis:{gridcolor:'#21262d',linecolor:'#30363d',title:{text:yTitle},rangemode:'tozero'},
    height:250,margin:{t:10,b:60,l:70,r:20},hovermode:'x unified',showlegend:false,
    annotations:annots
  };

  // Preserve x zoom if re-rendering
  const xRange = div.layout?.xaxis?.range;
  Plotly.react(div,traces,layout,{responsive:true,scrollZoom:true,displayModeBar:true,modeBarButtonsToRemove:['lasso2d','select2d']});
  if (xRange) Plotly.relayout(div,{'xaxis.range':xRange});
}

function switchView(bot, mode, field, btn) {
  btn.parentElement.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  renderPlot(bot, mode, field);
  const yTitle=view==='cum'?'total tokens':'tokens/hr';
  Plotly.react(div,traces,{...div.layout,yaxis:{...div.layout.yaxis,title:{text:yTitle}}});
  if (xRange) Plotly.relayout(div,{'xaxis.range':xRange});
}

load();
</script>`;
  return page('Token Usage' + (testMode ? ' (TEST)' : ''), '<div id="content">Loading...</div>' + script);
}

// Load pricing from S3 (or local fallback) on startup, refresh every 5 min
loadPricing().then(() => {
  setInterval(() => { loadPricing(); }, 5 * 60_000);
});

// ── S3 backup of tokens.db (R17) ──────────────────────────────────────
async function backupTokenDb(): Promise<void> {
  const dbPath = path.join(TOKEN_DB_DIR, 'tokens.db');
  if (!fs.existsSync(dbPath)) return;
  try {
    const s3 = await import('./s3-sync.js');
    const client = s3.getClient();
    if (!client) { console.log('token-backup: S3 not configured, skipping'); return; }
    const { PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    const zlib = await import('zlib');
    const { promisify } = await import('util');
    const gzip = promisify(zlib.gzip);

    // Compress and upload
    const date = new Date().toISOString().slice(0, 10);
    const key = `tokens/tokens.db.${date}.gz`;
    const raw = fs.readFileSync(dbPath);
    const compressed = await gzip(raw);
    await client.client.send(new PutObjectCommand({ Bucket: client.bucket, Key: key, Body: compressed }));
    console.log(`token-backup: uploaded ${key} (${(compressed.length / 1024).toFixed(0)} KB)`);

    // Prune old backups beyond BACKUP_RETAIN
    const list = await client.client.send(new ListObjectsV2Command({ Bucket: client.bucket, Prefix: 'tokens/tokens.db.' }));
    const keys = (list.Contents || []).map(o => o.Key!).sort();
    if (keys.length > BACKUP_RETAIN) {
      for (const old of keys.slice(0, keys.length - BACKUP_RETAIN)) {
        await client.client.send(new DeleteObjectCommand({ Bucket: client.bucket, Key: old }));
        console.log(`token-backup: pruned ${old}`);
      }
    }
  } catch (err) {
    console.log(`token-backup: failed: ${err}`);
  }
}
// Backup on startup + daily
backupTokenDb();
setInterval(backupTokenDb, BACKUP_INTERVAL_MS);

server.listen(PORT, () => {
  console.log(`Fleet dashboard listening on :${PORT}`);
  console.log(`  ${BASE}`);
  console.log(`  ${BASE}/bazaar`);
  console.log(`  ${BASE}/tokens`);
});
