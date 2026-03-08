import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { shellQuote, errStr, resolveRoot } from './utils.js';
import { logger } from 'nanoclaw/logger.js';

export function runHealthCheck(hostname: string): string | null {
  const root = resolveRoot();
  const script = path.join(root, 'scripts', 'health-check.sh');
  if (!fs.existsSync(script)) return null;
  try {
    return execSync(`bash ${shellQuote(script)} --json`, {
      encoding: 'utf-8',
      timeout: 30_000,
      env: { ...process.env, MACHINE_NAME: hostname },
    }).trim();
  } catch (err) {
    logger.error({ err: errStr(err) }, 'health-check.sh failed');
    return null;
  }
}

export function formatHealthSummary(reports: Array<{ ship: string; data: Record<string, any> }>): string {
  if (reports.length === 0) return '⚠️ No health reports available.';
  const lines: string[] = [`🏥 Fleet Health — ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC\n`];
  let totalOom = 0;
  let totalSessions = 0;

  for (const { ship, data } of reports) {
    const bots = (data.bots || {}) as Record<string, Record<string, any>>;
    const active = Object.entries(bots).filter(([, b]) => b.status === 'ACTIVE').map(([n]) => n);
    const ts = String(data.ts || '?').slice(0, 19);
    lines.push(`**${ship}** (${ts})`);
    lines.push(`  Active: ${active.length > 0 ? active.join(', ') : 'none'}`);

    for (const [name, b] of Object.entries(bots)) {
      const oom = Number(b.oom_kills || 0);
      totalOom += oom;
      if (b.status === 'ACTIVE' || oom > 0) {
        const mem = b.rss_mb != null ? `RSS=${b.rss_mb}/${b.limit_mb}MB` : '';
        lines.push(`  ${name}: ${b.status} ${mem} OOM=${oom}`);
      }
    }
    const sess = Number(data.session_total_mb || 0);
    totalSessions += sess;
    lines.push(`  Sessions: ${sess}MB\n`);
  }

  lines.push(`**Totals:** ${reports.length} ships, ${totalOom} OOM kills, ${totalSessions}MB sessions`);
  return lines.join('\n');
}
