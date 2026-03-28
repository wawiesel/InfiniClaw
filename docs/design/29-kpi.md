# 29 — KPI Framework

Per-bot configurable Key Performance Indicator scores for the fleet.

---

## Overview

The KPI framework gives each bot a single composite score that answers: **"How well is this bot doing its job?"** KPI is domain-specific — Parker's job is different from Cid's, so their formulas differ.

Three deliverables:

1. **`get_kpi` MCP tool** — bots call this to check their own performance or fleet KPIs
2. **Per-bot KPI config** — YAML-like JSON stored at `_runtime/data/kpi-config.json`
3. **Fleet dashboard panel** — KPI column in the IC01 fleet table at `fleet.a-gis.org`

---

## KPI Score

A KPI score is a float in **[0.0, 1.0]**. Higher is better.

```
score = Σ (weight_i × component_i)
where Σ weight_i = 1.0
and   component_i ∈ [0.0, 1.0]
```

---

## KPI Config

Stored at `{INFINICLAW_ROOT}/_runtime/data/kpi-config.json`.

```json
{
  "default": {
    "components": {
      "availability":    0.40,
      "autonomy_score":  0.30,
      "quality_score":   0.30
    }
  },
  "parker": {
    "components": {
      "ollama_uptime":     0.50,
      "roi_over_hodling":  0.50
    }
  }
}
```

The `default` formula applies to any bot without an explicit entry. Weights must sum to 1.0.

---

## Components

| Component | Range | Source | Description |
|-----------|-------|--------|-------------|
| `availability` | 0–1 | `status.json` → `hasProcess` | 1.0 if bot process is running |
| `autonomy_score` | 0–1 | `status.json` fleet block | `autonomyScore_1d / 100` |
| `quality_score` | 0–1 | `status.json` fleet block | `clamp((score_1d + 3) / 6, 0, 1)` — maps [−3..+3] range to [0..1] |
| `relay_uptime` | 0–1 | `status.json` fleet block | `relayUptimeSeconds / 86400` |
| `ollama_uptime` | 0–1 | `status.json` provider field | 1.0 if current brain is Ollama, else 0.0 (v1 binary; future: time-weighted) |
| `roi_over_hodling` | 0–1 | Parker's `signal/price_data.json` + `signal/state.json` | Normalized trading ROI vs hodling baseline; 0.5 = break-even |

### `roi_over_hodling` computation

ROI is computed from Parker's trading signal files:

1. Read `state.json` trade history — find first trade to establish entry baseline
2. Compute current portfolio value from `price_data.json` (`total` field)
3. Compute hodl value: what the initial USDC deployment would be worth if held as BTC
4. `roi_raw = (portfolio - hodl) / hodl` — can be negative
5. Normalize: `roi_over_hodling = clamp(0.5 + roi_raw / 2, 0, 1)` → 0.5 at break-even, 0 at −100%, 1 at +100%

If signal files are missing or insufficient trades exist: `roi_over_hodling = 0.5` (neutral).

---

## `get_kpi` MCP Tool

### Signature

```typescript
get_kpi({
  bot?: string  // bot name, "fleet" for all bots, or omit for self
})
```

### Output (single bot)

```
KPI: Parker — 0.73
  ollama_uptime    0.50 × 1.00 = 0.50
  roi_over_hodling 0.50 × 0.45 = 0.23
Formula: parker (custom)
```

### Output (fleet)

```
KPI Fleet Summary
  Parker  0.73  ██████████░░░░  (custom)
  Cid     0.81  ████████████░░  (default)
  Tali    0.76  ███████████░░░  (default)
```

### Resolution logic

1. Determine target bot: `args.bot || process.env.INFINICLAW_ASSISTANT_NAME || 'self'`
2. Load KPI config from `_runtime/data/kpi-config.json` (fallback to hardcoded defaults if missing)
3. Select formula: `config[botName.toLowerCase()] || config.default`
4. For each component, read data and compute value (see Components table above)
5. Apply weights, return formatted result

### Data access

The tool reads:
- `{INFINICLAW_ROOT}/_runtime/instances/{bot}/ipc/status.json` — bot status snapshot
- `{INFINICLAW_ROOT}/bots/engineer/parker/signal/price_data.json` — for `roi_over_hodling`
- `{INFINICLAW_ROOT}/bots/engineer/parker/signal/state.json` — for `roi_over_hodling`

For `bot = "fleet"`, iterates over all instances found under `_runtime/instances/`.

---

## Fleet Dashboard Panel

Add a KPI column to the fleet home table at `fleet.a-gis.org/infiniclaw/fleet/ic01`.

| Bot | Service | Model | Heartbeat | KPI | Containers | Tasks |
|-----|---------|-------|-----------|-----|------------|-------|
| Parker | 🟢 running | claude-sonnet | 12s ago | **0.73** | 1 | 2 |

KPI values are color-coded:
- ≥ 0.80 → green
- 0.60–0.79 → yellow
- < 0.60 → red
- `—` if no data

The KPI is computed live on each page render (same as other fleet status data). No caching layer needed at this scale.

---

## Bot Self-Monitoring

Each bot should call `get_kpi` periodically to self-monitor:

```
mcp__infiniclaw__get_kpi()  → check own KPI
```

Suggested practice: call at the start of a session and after completing major tasks. If KPI < 0.50, surface it to the Captain.

Parker's startup routine should check KPI alongside the trading bot auth check.

---

## Extension Points

- **New components**: Add to the `computeComponent()` function in `tools.ts` and document here
- **Time-weighted `ollama_uptime`**: Track brain switches in `_runtime/instances/{bot}/data/brain-history.json` (future)
- **Per-room formula**: `config["engineering"]` key for room-level defaults
- **KPI history**: Append scores to `_runtime/data/kpi-history.jsonl` for trend tracking (future)

---

## Files

| File | Role |
|------|------|
| `bots/container/agent-runner/src/tools.ts` | `get_kpi` tool registration |
| `src/dashboard-server.ts` | KPI column in fleet home table |
| `docs/design/29-kpi.md` | This spec |
| `_runtime/data/kpi-config.json` | Per-bot formula config (runtime, gitignored) |
