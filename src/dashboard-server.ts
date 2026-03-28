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

// ── KPI ────────────────────────────────────────────────────────────

interface KpiFormula { components: Record<string, number> }
interface KpiConfig { default: KpiFormula; [bot: string]: KpiFormula }

const KPI_DEFAULT_CONFIG: KpiConfig = {
  default: { components: { availability: 0.4, autonomy_score: 0.3, quality_score: 0.3 } },
  parker: { components: { ollama_uptime: 0.5, roi_over_hodling: 0.5 } },
};

function loadKpiConfig(): KpiConfig {
  const configPath = path.join(resolveRoot(), '_runtime/data/kpi-config.json');
  try { return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as KpiConfig; } catch { return KPI_DEFAULT_CONFIG; }
}

function readBotStatus(botName: string): Record<string, unknown> | null {
  const p = path.join(resolveRoot(), '_runtime/instances', botName, 'ipc/status.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>; } catch { return null; }
}

function kpiComponent(name: string, status: Record<string, unknown> | null): number {
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  switch (name) {
    case 'availability': {
      const groups = status?.['groups'] as Array<{ hasProcess?: boolean }> | undefined;
      return groups?.some(g => g.hasProcess) ? 1.0 : 0.0;
    }
    case 'autonomy_score': {
      const snap = status?.['metricsSnapshot'] as { fleet?: { autonomyScore?: { day1?: number } } } | undefined;
      const v = snap?.fleet?.autonomyScore?.day1;
      return v != null ? clamp(v / 100) : 0.5;
    }
    case 'quality_score': {
      const snap = status?.['metricsSnapshot'] as { bot?: { score?: { day1?: number } } } | undefined;
      const v = snap?.bot?.score?.day1;
      return v != null ? clamp((v + 3) / 6) : 0.5;
    }
    case 'relay_uptime': {
      const snap = status?.['metricsSnapshot'] as { shipMetrics?: { relayUptimeSeconds?: number } } | undefined;
      const v = snap?.shipMetrics?.relayUptimeSeconds;
      return v != null ? clamp(v / 86400) : 0.5;
    }
    case 'ollama_uptime': {
      const provider = (status?.['provider'] as string | undefined || '').toLowerCase();
      return provider === 'ollama' ? 1.0 : 0.0;
    }
    case 'roi_over_hodling': {
      try {
        const pd = JSON.parse(fs.readFileSync(path.join(SIGNAL_DIR, 'price_data.json'), 'utf-8')) as { total?: number };
        const st = JSON.parse(fs.readFileSync(path.join(SIGNAL_DIR, 'state.json'), 'utf-8')) as {
          trades?: Array<{ portfolio_value?: number }>;
        };
        const current = pd.total;
        const initial = (st.trades || []).find(t => t.portfolio_value != null)?.portfolio_value;
        if (!current || !initial) return 0.5;
        return clamp(0.5 + (current - initial) / initial / 2);
      } catch { return 0.5; }
    }
    default: return 0.5;
  }
}

function computeBotKpi(botName: string, config: KpiConfig): number | null {
  const formula = config[botName.toLowerCase()] || config['default'];
  if (!formula) return null;
  const status = readBotStatus(botName.toLowerCase());
  let score = 0;
  for (const [comp, weight] of Object.entries(formula.components)) {
    score += weight * kpiComponent(comp, status);
  }
  return score;
}

function kpiBadge(score: number | null): string {
  if (score == null) return '—';
  const cls = score >= 0.8 ? 'ok' : score >= 0.6 ? 'warn' : 'err';
  return `<span class="badge ${cls}">${score.toFixed(2)}</span>`;
}

// ── Pages ──────────────────────────────────────────────────────────

function fleetHome(): string {
  const status = getSystemStatus(resolveRoot());
  const kpiConfig = loadKpiConfig();

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
    const kpi = computeBotKpi(b.name, kpiConfig);
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
    const kpi = computeBotKpi(b.name, kpiConfig);
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

  res.writeHead(302, { Location: BASE });
  res.end();
});

server.listen(PORT, () => {
  console.log(`Fleet dashboard listening on :${PORT}`);
  console.log(`  ${BASE}`);
  console.log(`  ${BASE}/bazaar`);
});
