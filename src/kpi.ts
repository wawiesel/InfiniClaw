/**
 * KPI computation — shared by dashboard-server and (by copy) agent-runner tools.
 * Design: docs/design/29-kpi-framework.md
 */
import fs from 'fs';
import path from 'path';

export interface KpiFormula { components: Record<string, number> }
export interface KpiConfig { default: KpiFormula; [bot: string]: KpiFormula }

export const KPI_DEFAULT_CONFIG: KpiConfig = {
  default: { components: { availability: 0.4, autonomy_score: 0.3, quality_score: 0.3 } },
  parker: { components: { ollama_uptime: 0.5, roi_over_hodling: 0.5 } },
};

export function loadKpiConfig(root: string): KpiConfig {
  const configPath = path.join(root, '_runtime/data/kpi-config.json');
  try { return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as KpiConfig; } catch { return KPI_DEFAULT_CONFIG; }
}

export function readBotStatus(root: string, botName: string): Record<string, unknown> | null {
  const p = path.join(root, '_runtime/instances', botName, 'ipc/status.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>; } catch { return null; }
}

function clamp(v: number): number { return Math.max(0, Math.min(1, v)); }

export function kpiComponent(name: string, status: Record<string, unknown> | null, signalDir: string): number {
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
        const pd = JSON.parse(fs.readFileSync(path.join(signalDir, 'price_data.json'), 'utf-8')) as { total?: number };
        const st = JSON.parse(fs.readFileSync(path.join(signalDir, 'state.json'), 'utf-8')) as {
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

export function computeBotKpi(root: string, botName: string, config: KpiConfig): number | null {
  const formula = config[botName.toLowerCase()] || config['default'];
  if (!formula) return null;
  const status = readBotStatus(root, botName.toLowerCase());
  const signalDir = path.join(root, 'bots/trader/parker/signal');
  let score = 0;
  for (const [comp, weight] of Object.entries(formula.components)) {
    score += weight * kpiComponent(comp, status, signalDir);
  }
  return score;
}

export function kpiBadge(score: number | null): string {
  if (score == null) return '—';
  const cls = score >= 0.8 ? 'ok' : score >= 0.6 ? 'warn' : 'err';
  return `<span class="badge ${cls}">${score.toFixed(2)}</span>`;
}
