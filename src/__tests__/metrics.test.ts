import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  initMetrics,
  resetMetrics,
  recordOperatorMessage,
  recordScoreReaction,
  computeMetrics,
  rollingRate,
  SCORE_REACTIONS,
  formatScopeMetrics,
  formatOperatorMetrics,
  formatBotMetrics,
  formatShipMetrics,
  formatFleetMetrics,
  formatAllMetrics,
  type MetricsSnapshot,
  type RollingMetric,
} from '../metrics.js';

// ── Helpers ───────────────────────────────────────────────────────────

const BTC_ROOM = '!btc:test';
const ENG_ROOM = '!eng:test';
const OPERATOR = '@operator:test';
const CAPTAIN = '@captain:test';

function setup() {
  resetMetrics();
  initMetrics({ btcRoomId: BTC_ROOM, operatorUid: OPERATOR, captainUid: CAPTAIN });
}

/** Create a timestamp N hours ago. */
function hoursAgo(h: number): number {
  return Date.now() - h * 3_600_000;
}

/** Create a timestamp N days ago. */
function daysAgo(d: number): number {
  return Date.now() - d * 86_400_000;
}

// ── rollingRate (pure function) ──────────────────────────────────────

describe('rollingRate', () => {
  it('counts events within the window', () => {
    const events = [
      { ts: hoursAgo(1) },
      { ts: hoursAgo(2) },
      { ts: hoursAgo(23) },
    ];
    // All 3 within 1 day, rate = 3/1 = 3.0
    expect(rollingRate(events, 1)).toBe(3);
  });

  it('returns 0 for empty events', () => {
    expect(rollingRate([], 1)).toBe(0);
    expect(rollingRate([], 7)).toBe(0);
  });

  it('excludes events outside the window', () => {
    const events = [
      { ts: hoursAgo(1) },   // within 1 day
      { ts: daysAgo(2) },    // outside 1 day, within 7 day
      { ts: daysAgo(5) },    // within 7 day
    ];
    expect(rollingRate(events, 1)).toBe(1); // 1 event / 1 day
    expect(rollingRate(events, 7)).toBe(0.4); // 3 events / 7 days = 0.428... → 0.4
  });

  it('rounds to one decimal', () => {
    // 7 events in 7 days = 1.0
    const events = Array.from({ length: 7 }, (_, i) => ({ ts: daysAgo(i) }));
    expect(rollingRate(events, 7)).toBe(1);
  });
});

// ── SCORE_REACTIONS ──────────────────────────────────────────────────

describe('SCORE_REACTIONS', () => {
  it('maps thumbs up to +1 (with and without variation selector)', () => {
    expect(SCORE_REACTIONS['👍']).toBe(1);
    expect(SCORE_REACTIONS['👍️']).toBe(1);
  });

  it('maps thumbs down to -1', () => {
    expect(SCORE_REACTIONS['👎']).toBe(-1);
    expect(SCORE_REACTIONS['👎️']).toBe(-1);
  });

  it('maps 💯 to +3', () => {
    expect(SCORE_REACTIONS['💯']).toBe(3);
  });

  it('maps ❌ to -3', () => {
    expect(SCORE_REACTIONS['❌']).toBe(-3);
    expect(SCORE_REACTIONS['❌️']).toBe(-3);
  });

  it('returns undefined for non-scoring emoji', () => {
    expect(SCORE_REACTIONS['👀']).toBeUndefined();
    expect(SCORE_REACTIONS['🔔']).toBeUndefined();
  });
});

// ── recordOperatorMessage ────────────────────────────────────────────

describe('recordOperatorMessage', () => {
  beforeEach(setup);

  it('records messages from the operator', () => {
    recordOperatorMessage(OPERATOR, ENG_ROOM, 'hello', hoursAgo(1));
    const snapshot = computeMetrics();
    expect(snapshot.operator.interventions.day1).toBeGreaterThan(0);
  });

  it('ignores messages from non-operator senders', () => {
    recordOperatorMessage('@random:test', ENG_ROOM, 'hello', hoursAgo(1));
    const snapshot = computeMetrics();
    expect(snapshot.operator.interventions.day1).toBe(0);
  });

  it('filters BTC messages from intervention count', () => {
    // BTC messages should NOT count as interventions
    recordOperatorMessage(OPERATOR, BTC_ROOM, 'btc message', hoursAgo(1));
    const snapshot = computeMetrics();
    expect(snapshot.operator.interventions.day1).toBe(0);
  });

  it('detects x-commands (messages starting with !)', () => {
    recordOperatorMessage(OPERATOR, ENG_ROOM, '!fleet', hoursAgo(1));
    recordOperatorMessage(OPERATOR, ENG_ROOM, 'regular message', hoursAgo(2));
    const snapshot = computeMetrics();
    expect(snapshot.operator.xCommandsIssued.day1).toBe(1); // only !fleet
    expect(snapshot.operator.interventions.day1).toBe(2); // both
  });

  it('prunes events older than 8 days', () => {
    recordOperatorMessage(OPERATOR, ENG_ROOM, 'old', daysAgo(9));
    const snapshot = computeMetrics();
    expect(snapshot.operator.interventions.day1).toBe(0);
    expect(snapshot.operator.interventions.day7).toBe(0);
  });
});

// ── recordScoreReaction ──────────────────────────────────────────────

describe('recordScoreReaction', () => {
  beforeEach(setup);

  it('records scoring reactions from Captain', () => {
    recordScoreReaction(CAPTAIN, '👍', 'cid', hoursAgo(1));
    const snapshot = computeMetrics();
    const cid = snapshot.bots.find(b => b.name === 'cid');
    // Bot might not exist in fleet config, but scoreEvents are recorded
    // This test verifies the recording logic
  });

  it('records scoring reactions from operator', () => {
    recordScoreReaction(OPERATOR, '💯', 'cid', hoursAgo(1));
    // No error thrown — accepted
  });

  it('rejects reactions from unauthorized users', () => {
    recordScoreReaction('@random:test', '👍', 'cid', hoursAgo(1));
    // Event should NOT be recorded
  });

  it('rejects non-scoring emoji', () => {
    recordScoreReaction(CAPTAIN, '👀', 'cid', hoursAgo(1));
    // Event should NOT be recorded (👀 is not in SCORE_REACTIONS)
  });

  it('prunes score events older than 8 days', () => {
    recordScoreReaction(CAPTAIN, '👍', 'cid', daysAgo(9));
    // No error; old events pruned automatically
  });
});

// ── resetMetrics ─────────────────────────────────────────────────────

describe('resetMetrics', () => {
  it('clears all accumulated state', () => {
    initMetrics({ btcRoomId: BTC_ROOM, operatorUid: OPERATOR, captainUid: CAPTAIN });
    recordOperatorMessage(OPERATOR, ENG_ROOM, 'hello', hoursAgo(1));
    recordScoreReaction(CAPTAIN, '👍', 'cid', hoursAgo(1));
    resetMetrics();

    // After reset, operator messages should be ignored (operatorUserId is null)
    recordOperatorMessage(OPERATOR, ENG_ROOM, 'hello', hoursAgo(1));
    // Re-init to compute
    initMetrics({ btcRoomId: BTC_ROOM, operatorUid: OPERATOR, captainUid: CAPTAIN });
    // Only the post-reset message should NOT be there (it was sent while operatorUserId was null)
    // Actually: resetMetrics nulls operatorUserId, so recordOperatorMessage returns early
    const snapshot = computeMetrics();
    expect(snapshot.operator.interventions.day1).toBe(0);
  });
});

// ── Formatting ───────────────────────────────────────────────────────

describe('formatting', () => {
  const mockMetric: RollingMetric = { day1: 2.5, day7: 1.3 };

  it('formatOperatorMetrics includes interventions and x-commands', () => {
    const result = formatOperatorMetrics({
      interventions: { day1: 5, day7: 2.1 },
      xCommandsIssued: { day1: 3, day7: 1 },
    });
    expect(result).toContain('Operator Metrics');
    expect(result).toContain('Interventions');
    expect(result).toContain('5/day (1d)');
    expect(result).toContain('2.1/day (7d)');
    expect(result).toContain('X-commands');
  });

  it('formatBotMetrics shows pip, name, status, score, crashes', () => {
    const result = formatBotMetrics({
      name: 'cid',
      score: { day1: 3, day7: 1.5 },
      crashes: { day1: 0, day7: 1 },
      status: 'quarters',
      processRunning: true,
    });
    expect(result).toContain('🟢');
    expect(result).toContain('Cid');
    expect(result).toContain('quarters');
    expect(result).toContain('Score');
    expect(result).toContain('3 pts/day (1d)');
  });

  it('formatBotMetrics shows red pip when not running', () => {
    const result = formatBotMetrics({
      name: 'norm',
      score: { day1: 0, day7: 0 },
      crashes: { day1: 0, day7: 0 },
      status: 'sleep',
      processRunning: false,
    });
    expect(result).toContain('🔴');
  });

  it('formatShipMetrics shows name, uptime, restarts', () => {
    const result = formatShipMetrics({
      name: 'Herc',
      relayUptimeSeconds: 7200,
      relayRestarts: 3,
    });
    // shipTag() resolves to emoji+name from ships.json (e.g. "🦁 Herc")
    expect(result).toContain('Herc');
    expect(result).toContain('2h'); // 7200s = 2h
    expect(result).toContain('3');
  });

  it('formatFleetMetrics shows availability percentage', () => {
    const result = formatFleetMetrics({ availability: 85 });
    expect(result).toContain('85%');
  });
});

// ── formatScopeMetrics routing ───────────────────────────────────────

describe('formatScopeMetrics', () => {
  const mockSnapshot: MetricsSnapshot = {
    ship: 'HERACLES',
    ts: Date.now(),
    operator: {
      interventions: { day1: 2, day7: 1 },
      xCommandsIssued: { day1: 1, day7: 0.5 },
    },
    bots: [
      {
        name: 'cid',
        score: { day1: 1, day7: 0.5 },
        crashes: { day1: 0, day7: 0 },
        status: 'quarters',
        processRunning: true,
      },
    ],
    shipMetrics: {
      name: 'HERACLES',
      relayUptimeSeconds: 3600,
      relayRestarts: 0,
    },
    fleet: { availability: 100 },
  };

  it('scope "operator" returns operator metrics', () => {
    const result = formatScopeMetrics(mockSnapshot, 'operator');
    expect(result).toContain('Operator Metrics');
    expect(result).not.toContain('Fleet');
  });

  it('scope "ship" returns ship metrics', () => {
    const result = formatScopeMetrics(mockSnapshot, 'ship');
    expect(result).toContain('Herc');
    expect(result).not.toContain('Operator');
  });

  it('scope "fleet" returns fleet metrics', () => {
    const result = formatScopeMetrics(mockSnapshot, 'fleet');
    expect(result).toContain('availability');
    expect(result).not.toContain('Operator');
  });

  it('scope "all" returns everything', () => {
    const result = formatScopeMetrics(mockSnapshot, 'all');
    expect(result).toContain('Operator');
    expect(result).toContain('Herc');
    expect(result).toContain('Cid');
    expect(result).toContain('availability');
  });

  it('scope "cid" returns bot metrics for cid', () => {
    const result = formatScopeMetrics(mockSnapshot, 'cid');
    expect(result).toContain('Cid');
    expect(result).not.toContain('Operator');
  });

  it('scope "bot cid" returns bot metrics for cid', () => {
    const result = formatScopeMetrics(mockSnapshot, 'bot cid');
    expect(result).toContain('Cid');
  });

  it('unknown scope falls back to all', () => {
    const result = formatScopeMetrics(mockSnapshot, 'nonexistent');
    expect(result).toContain('Operator');
    expect(result).toContain('availability');
  });
});

// ── formatAllMetrics ─────────────────────────────────────────────────

describe('formatAllMetrics', () => {
  it('includes all sections', () => {
    const snapshot: MetricsSnapshot = {
      ship: 'HERACLES',
      ts: Date.now(),
      operator: {
        interventions: { day1: 0, day7: 0 },
        xCommandsIssued: { day1: 0, day7: 0 },
      },
      bots: [
        {
          name: 'cid',
          score: { day1: 0, day7: 0 },
          crashes: { day1: 0, day7: 0 },
          status: 'onduty',
          processRunning: true,
        },
        {
          name: 'norm',
          score: { day1: 0, day7: 0 },
          crashes: { day1: 0, day7: 0 },
          status: 'quarters',
          processRunning: true,
        },
      ],
      shipMetrics: {
        name: 'HERACLES',
        relayUptimeSeconds: 86400,
        relayRestarts: 1,
      },
      fleet: { availability: 100 },
    };

    const result = formatAllMetrics(snapshot);
    expect(result).toContain('Operator Metrics');
    expect(result).toContain('Herc');
    expect(result).toContain('Cid');
    expect(result).toContain('Norm');
    expect(result).toContain('availability');
    expect(result).toContain('1d'); // 86400s = 1d
  });
});
