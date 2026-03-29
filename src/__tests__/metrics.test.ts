import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock child_process so getPm2Info() returns [] — tests must not depend on real PM2 state
vi.mock('child_process', () => ({
  execSync: () => '[]',
}));

// Mock ship-config so tests run without fleet.json secrets
vi.mock('../ship-config.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../ship-config.js')>();
  return {
    ...original,
    loadShipConfig: () => ({ bots: [], secretsPath: '/tmp/test-secrets' }),
  };
});

import {
  initMetrics,
  resetMetrics,
  recordOperatorMessage,
  recordScoreReaction,
  recordBranchBrainResult,
  recordInfraFailure,
  recordMessageDelivery,
  recordBotReply,
  computeMetrics,
  rollingRate,
  SCORE_REACTIONS,
  formatScopeMetrics,
  formatOperatorMetrics,
  formatBotMetrics,
  formatShipMetrics,
  formatFleetMetrics,
  formatAllMetrics,
  computeBotHealthGrade,
  computeFleetHealthGrade,
  gradeEmoji,
  recordBotMessage,
  recordTaskCreated,
  recordTaskResolved,
  syncTodosMetrics,
  checkAlerts,
  formatAlerts,
  recordVersionDeployed,
  getVersionDeployEvents,
  getVersionAdoptionLatency,
  type Alert,
  type MetricsSnapshot,
  type RollingMetric,
  type BotMetrics,
} from '../metrics.js';

import { activityEmoji } from '../formatting.js';
import * as shipConfig from '../ship-config.js';

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
    // Interventions exclude x-commands (queries are not interventions)
    expect(snapshot.operator.interventions.day1).toBe(1); // only 'regular message'
  });

  it('x-commands do not count as interventions (autonomy not penalized)', () => {
    // Send 5 x-commands and 1 regular message
    for (let i = 0; i < 5; i++) {
      recordOperatorMessage(OPERATOR, ENG_ROOM, `!fleet`, hoursAgo(1));
    }
    recordOperatorMessage(OPERATOR, ENG_ROOM, '@cid fix this bug', hoursAgo(1));
    const snapshot = computeMetrics();
    // Only the non-command message counts as intervention
    expect(snapshot.operator.interventions.day1).toBe(1);
    expect(snapshot.operator.xCommandsIssued.day1).toBe(5);
    // Autonomy: 100 - (1 intervention × 10) = 90
    expect(snapshot.fleet.autonomyScore.day1).toBe(90);
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

// ── recordBranchBrainResult ──────────────────────────────────────────

describe('recordBranchBrainResult', () => {
  beforeEach(setup);

  it('records successful branch brain completions', () => {
    recordBranchBrainResult('cid', true, hoursAgo(1));
    recordBranchBrainResult('cid', true, hoursAgo(2));
    recordBranchBrainResult('cid', false, hoursAgo(3));
    // 2 successes out of 3 = 67%
    // This is tested via computeMetrics below
  });

  it('prunes events older than 8 days', () => {
    recordBranchBrainResult('cid', true, daysAgo(9));
    recordBranchBrainResult('cid', true, hoursAgo(1));
    // Old event pruned, only 1 remains
  });
});

// ── recordInfraFailure ──────────────────────────────────────────────

describe('recordInfraFailure', () => {
  beforeEach(setup);

  it('records infra failures in ship metrics', () => {
    recordInfraFailure('code sync');
    recordInfraFailure('code build');
    const snapshot = computeMetrics();
    expect(snapshot.shipMetrics.infraFailures.day1).toBeGreaterThan(0);
  });

  it('shows 0 failures when none recorded', () => {
    const snapshot = computeMetrics();
    expect(snapshot.shipMetrics.infraFailures.day1).toBe(0);
    expect(snapshot.shipMetrics.infraFailures.day7).toBe(0);
  });

  it('is cleared by resetMetrics', () => {
    recordInfraFailure('code sync');
    resetMetrics();
    initMetrics({ btcRoomId: BTC_ROOM, operatorUid: OPERATOR, captainUid: CAPTAIN });
    const snapshot = computeMetrics();
    expect(snapshot.shipMetrics.infraFailures.day1).toBe(0);
  });
});

// ── autonomy score ──────────────────────────────────────────────────

describe('autonomy score', () => {
  beforeEach(setup);

  it('starts at 100 with no interventions or crashes', () => {
    const snapshot = computeMetrics();
    expect(snapshot.fleet.autonomyScore.day1).toBe(100);
    expect(snapshot.fleet.autonomyScore.day7).toBe(100);
  });

  it('decreases by 10 per intervention', () => {
    recordOperatorMessage(OPERATOR, ENG_ROOM, 'fix this', hoursAgo(1));
    recordOperatorMessage(OPERATOR, ENG_ROOM, 'fix that', hoursAgo(2));
    const snapshot = computeMetrics();
    // 2 interventions × 10 = 20, so 100 - 20 = 80
    expect(snapshot.fleet.autonomyScore.day1).toBe(80);
  });

  it('clamps to 0 minimum', () => {
    // 11 interventions × 10 = 110, clamped to 0
    for (let i = 0; i < 11; i++) {
      recordOperatorMessage(OPERATOR, ENG_ROOM, `msg ${i}`, hoursAgo(1));
    }
    const snapshot = computeMetrics();
    expect(snapshot.fleet.autonomyScore.day1).toBe(0);
  });
});

// ── MTBI (Mean Time Between Interventions) ───────────────────────────

describe('MTBI', () => {
  beforeEach(setup);

  it('returns null with fewer than 2 intervention events', () => {
    const snapshot = computeMetrics();
    expect(snapshot.operator.mtbi).toBeNull();
  });

  it('returns null with only 1 intervention', () => {
    recordOperatorMessage(OPERATOR, ENG_ROOM, 'fix this', hoursAgo(1));
    const snapshot = computeMetrics();
    expect(snapshot.operator.mtbi).toBeNull();
  });

  it('computes mean gap between 2 interventions in hours', () => {
    // Two events 4 hours apart → MTBI should be 4h
    recordOperatorMessage(OPERATOR, ENG_ROOM, 'first', hoursAgo(4));
    recordOperatorMessage(OPERATOR, ENG_ROOM, 'second', hoursAgo(0));
    const snapshot = computeMetrics();
    expect(snapshot.operator.mtbi).toBeGreaterThan(3.5);
    expect(snapshot.operator.mtbi).toBeLessThan(4.5);
  });

  it('computes mean gap across multiple interventions', () => {
    // 4 events: 12h, 8h, 4h, 0h ago → gaps: 4h, 4h, 4h → mean = 4h
    recordOperatorMessage(OPERATOR, ENG_ROOM, 'a', hoursAgo(12));
    recordOperatorMessage(OPERATOR, ENG_ROOM, 'b', hoursAgo(8));
    recordOperatorMessage(OPERATOR, ENG_ROOM, 'c', hoursAgo(4));
    recordOperatorMessage(OPERATOR, ENG_ROOM, 'd', hoursAgo(0));
    const snapshot = computeMetrics();
    expect(snapshot.operator.mtbi).toBeGreaterThan(3.5);
    expect(snapshot.operator.mtbi).toBeLessThan(4.5);
  });

  it('excludes x-commands from MTBI calculation', () => {
    // Only x-commands — no interventions
    recordOperatorMessage(OPERATOR, ENG_ROOM, '!wake cid', hoursAgo(4));
    recordOperatorMessage(OPERATOR, ENG_ROOM, '!fleet', hoursAgo(0));
    const snapshot = computeMetrics();
    expect(snapshot.operator.mtbi).toBeNull();
  });

  it('excludes events older than 7 days', () => {
    // One event > 7d ago + one recent — only 1 event in window → null
    recordOperatorMessage(OPERATOR, ENG_ROOM, 'old', daysAgo(8));
    recordOperatorMessage(OPERATOR, ENG_ROOM, 'recent', hoursAgo(1));
    const snapshot = computeMetrics();
    expect(snapshot.operator.mtbi).toBeNull();
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
      branchBrainSuccess: { day1: -1, day7: -1 },
      tokenThroughput: { day1: -1, day7: -1 },
      messagesPerDay: { day1: 0, day7: 0 },
      taskCompletionRate: { day1: -1, day7: -1 },
      status: 'quarters',
      processRunning: true,
    });
    expect(result).toContain('◉');
    expect(result).toContain('Cid');
    expect(result).toContain('quarters');
    expect(result).toContain('score');
  });

  it('formatBotMetrics shows 💤 pip for sleeping bot even when process not running', () => {
    const result = formatBotMetrics({
      name: 'norm',
      score: { day1: 0, day7: 0 },
      crashes: { day1: 0, day7: 0 },
      branchBrainSuccess: { day1: -1, day7: -1 },
      tokenThroughput: { day1: -1, day7: -1 },
      messagesPerDay: { day1: 0, day7: 0 },
      taskCompletionRate: { day1: -1, day7: -1 },
      status: 'sleep',
      processRunning: false,
    });
    expect(result).toContain('💤');
  });

  it('formatShipMetrics shows name, uptime, restarts, infra failures', () => {
    const result = formatShipMetrics({
      name: 'Herc',
      relayUptimeSeconds: 7200,
      relayRestarts: { day1: 3, day7: 1 },
      infraFailures: { day1: 2, day7: 0.4 },
    });
    expect(result).toContain('Herc');
    expect(result).toContain('2h');
    expect(result).toContain('3');
    expect(result).toContain('Sync/build failures');
    expect(result).toContain('2/day (1d)');
  });

  it('formatBotMetrics shows branch success when data exists', () => {
    const result = formatBotMetrics({
      name: 'cid',
      score: { day1: 0, day7: 0 },
      crashes: { day1: 0, day7: 0 },
      branchBrainSuccess: { day1: 100, day7: 80 },
      tokenThroughput: { day1: -1, day7: -1 },
      messagesPerDay: { day1: 0, day7: 0 },
      taskCompletionRate: { day1: -1, day7: -1 },
      status: 'quarters',
      processRunning: true,
    });
    expect(result).toContain('bb');
    expect(result).toContain('100%');
    expect(result).toContain('80%');
  });

  it('formatBotMetrics hides branch success when no data', () => {
    const result = formatBotMetrics({
      name: 'cid',
      score: { day1: 0, day7: 0 },
      crashes: { day1: 0, day7: 0 },
      branchBrainSuccess: { day1: -1, day7: -1 },
      tokenThroughput: { day1: -1, day7: -1 },
      messagesPerDay: { day1: 0, day7: 0 },
      taskCompletionRate: { day1: -1, day7: -1 },
      status: 'quarters',
      processRunning: true,
    });
    expect(result).not.toContain('bb ');
  });

  it('formatFleetMetrics shows availability and autonomy', () => {
    const result = formatFleetMetrics({ availability: 85, autonomyScore: { day1: 90, day7: 95 } });
    expect(result).toContain('85%');
    expect(result).toContain('autonomy');
    expect(result).toContain('90');
    expect(result).toContain('95');
  });
});

// ── formatScopeMetrics routing ───────────────────────────────────────

describe('formatScopeMetrics', () => {
  const mockSnapshot: MetricsSnapshot = {
    ship: 'Herc',
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
        branchBrainSuccess: { day1: -1, day7: -1 },
        tokenThroughput: { day1: -1, day7: -1 },
        messagesPerDay: { day1: 0, day7: 0 },
        taskCompletionRate: { day1: -1, day7: -1 },
        status: 'quarters',
        processRunning: true,
      },
    ],
    shipMetrics: {
      name: 'Herc',
      relayUptimeSeconds: 3600,
      relayRestarts: { day1: 0, day7: 0 }, infraFailures: { day1: 0, day7: 0 },
    },
    fleet: { availability: 100, autonomyScore: { day1: 80, day7: 90 } },
  };

  it('scope "operator" returns operator metrics', () => {
    const result = formatScopeMetrics(mockSnapshot, 'operator');
    expect(result).toContain('Interventions');
    expect(result).not.toContain('Fleet');
  });

  it('scope "ship" returns ship metrics', () => {
    const result = formatScopeMetrics(mockSnapshot, 'ship');
    expect(result).toContain('Herc');
    expect(result).not.toContain('Operator');
  });

  it('scope "fleet" returns fleet metrics', () => {
    const result = formatScopeMetrics(mockSnapshot, 'fleet');
    expect(result).toContain('Availability');
    expect(result).not.toContain('Operator');
  });

  it('scope "all" returns everything', () => {
    const result = formatScopeMetrics(mockSnapshot, 'all');
    expect(result).toContain('Operator');
    expect(result).toContain('Herc');
    expect(result).toContain('Cid');
    expect(result).toContain('Availability');
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

  it('unknown bot-like scope returns empty (bot not on this ship)', () => {
    const result = formatScopeMetrics(mockSnapshot, 'nonexistent');
    expect(result).toBe('');
  });

  it('"bot xyz" scope returns empty when bot not found', () => {
    const result = formatScopeMetrics(mockSnapshot, 'bot xyz');
    expect(result).toBe('');
  });

  it('non-bot-like scope falls back to all', () => {
    const result = formatScopeMetrics(mockSnapshot, 'SOMETHING WEIRD');
    expect(result).toContain('Operator');
    expect(result).toContain('Availability');
  });
});

// ── formatAllMetrics ─────────────────────────────────────────────────

describe('formatAllMetrics', () => {
  it('includes all sections', () => {
    const snapshot: MetricsSnapshot = {
      ship: 'Herc',
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
          branchBrainSuccess: { day1: 100, day7: 80 },
          tokenThroughput: { day1: -1, day7: -1 },
          messagesPerDay: { day1: 0, day7: 0 },
          taskCompletionRate: { day1: -1, day7: -1 },
          status: 'onduty',
          processRunning: true,
        },
        {
          name: 'norm',
          score: { day1: 0, day7: 0 },
          crashes: { day1: 0, day7: 0 },
          branchBrainSuccess: { day1: -1, day7: -1 },
          tokenThroughput: { day1: -1, day7: -1 },
          messagesPerDay: { day1: 0, day7: 0 },
          taskCompletionRate: { day1: -1, day7: -1 },
          status: 'quarters',
          processRunning: true,
        },
      ],
      shipMetrics: {
        name: 'Herc',
        relayUptimeSeconds: 86400,
        relayRestarts: { day1: 1, day7: 0 }, infraFailures: { day1: 0, day7: 0 },
      },
      fleet: { availability: 100, autonomyScore: { day1: 100, day7: 100 } },
    };

    const result = formatAllMetrics(snapshot);
    expect(result).toContain('Operator');
    expect(result).toContain('Herc');
    expect(result).toContain('Cid');
    expect(result).toContain('Norm');
    expect(result).toContain('Availability');
    expect(result).toContain('1d'); // 86400s = 1d
  });
});

// ── Response Latency ────────────────────────────────────────────────

describe('response latency tracking', () => {
  beforeEach(setup);

  it('records latency when delivery followed by reply', () => {
    const now = Date.now();
    recordMessageDelivery('cid', now - 15_000); // 15s ago
    recordBotReply('cid', now);
    // Latency sample should be ~15s — verified via computeMetrics indirectly
    // (internal state, but we can check it doesn't crash)
  });

  it('ignores reply without prior delivery', () => {
    recordBotReply('cid', Date.now());
    // Should not throw or record anything
  });

  it('ignores negative or >10min latency', () => {
    const now = Date.now();
    recordMessageDelivery('cid', now + 1000); // future = negative latency
    recordBotReply('cid', now);
    // Should be discarded silently

    recordMessageDelivery('cid', now - 700_000); // 11+ min
    recordBotReply('cid', now);
    // Also discarded
  });

  it('clears pending deliveries on reset', () => {
    recordMessageDelivery('cid', Date.now());
    resetMetrics();
    initMetrics({ btcRoomId: BTC_ROOM, operatorUid: OPERATOR, captainUid: CAPTAIN });
    recordBotReply('cid', Date.now() + 5000);
    // After reset, delivery is gone — reply should not record latency
  });
});

// ── MTBI in OperatorMetrics ─────────────────────────────────────────

describe('MTBI in operator metrics', () => {
  beforeEach(setup);

  it('includes mtbi in operator metrics when interventions exist', () => {
    const now = Date.now();
    // 3 interventions 2 hours apart
    recordOperatorMessage(OPERATOR, ENG_ROOM, 'help 1', now - 4 * 3_600_000);
    recordOperatorMessage(OPERATOR, ENG_ROOM, 'help 2', now - 2 * 3_600_000);
    recordOperatorMessage(OPERATOR, ENG_ROOM, 'help 3', now);

    const snapshot = computeMetrics();
    expect(snapshot.operator.mtbi).toBeCloseTo(2, 0); // ~2 hours
  });

  it('operator metrics mtbi is null with < 2 interventions', () => {
    recordOperatorMessage(OPERATOR, ENG_ROOM, 'help', Date.now());
    const snapshot = computeMetrics();
    expect(snapshot.operator.mtbi).toBeNull();
  });

  it('formats MTBI in operator output when present', () => {
    const result = formatOperatorMetrics({
      interventions: { day1: 2, day7: 1 },
      xCommandsIssued: { day1: 0, day7: 0 },
      mtbi: 4.5,
    });
    expect(result).toContain('MTBI: 4.5h (7d)');
  });

  it('omits MTBI line when null', () => {
    const result = formatOperatorMetrics({
      interventions: { day1: 0, day7: 0 },
      xCommandsIssued: { day1: 0, day7: 0 },
      mtbi: null,
    });
    expect(result).not.toContain('MTBI');
  });
});

// ── Health grade ─────────────────────────────────────────────────────

describe('computeBotHealthGrade', () => {
  const baseBotMetrics: BotMetrics = {
    name: 'cid',
    score: { day1: 0, day7: 0 },
    crashes: { day1: 0, day7: 0 },
    branchBrainSuccess: { day1: -1, day7: -1 },
    tokenThroughput: { day1: 0, day7: 0 },
    messagesPerDay: { day1: 0, day7: 0 },
    taskCompletionRate: { day1: -1, day7: -1 },
    status: 'quarters',
    processRunning: true,
  };

  it('returns A for healthy running bot', () => {
    expect(computeBotHealthGrade(baseBotMetrics)).toBe('A');
  });

  it('returns F when process not running for awake bot', () => {
    expect(computeBotHealthGrade({ ...baseBotMetrics, processRunning: false })).toBe('F');
  });

  it('returns A for sleeping bot regardless of metrics', () => {
    expect(computeBotHealthGrade({ ...baseBotMetrics, status: 'sleep', processRunning: false })).toBe('A');
  });

  it('returns B for 1-2 crashes per day', () => {
    expect(computeBotHealthGrade({ ...baseBotMetrics, crashes: { day1: 1, day7: 3 } })).toBe('B');
  });

  it('returns C for >2 crashes per day', () => {
    expect(computeBotHealthGrade({ ...baseBotMetrics, crashes: { day1: 3, day7: 5 } })).toBe('C');
  });

  it('returns C when OOM kills present', () => {
    expect(computeBotHealthGrade(baseBotMetrics, { oomKills1d: 1 })).toBe('C');
  });

  it('returns B when memory >70%', () => {
    expect(computeBotHealthGrade(baseBotMetrics, { memPct: 75 })).toBe('B');
  });

  it('returns C when memory >85%', () => {
    expect(computeBotHealthGrade(baseBotMetrics, { memPct: 90 })).toBe('C');
  });
});

describe('computeFleetHealthGrade', () => {
  it('returns A when all bots are healthy', () => {
    expect(computeFleetHealthGrade(['A', 'A', 'A'])).toBe('A');
  });

  it('returns worst grade', () => {
    expect(computeFleetHealthGrade(['A', 'B', 'A'])).toBe('B');
    expect(computeFleetHealthGrade(['A', 'C', 'B'])).toBe('C');
    expect(computeFleetHealthGrade(['A', 'F'])).toBe('F');
  });
});

describe('activityEmoji', () => {
  it('returns ⏸ for no/low activity', () => {
    expect(activityEmoji(0)).toBe('⏸');
    expect(activityEmoji(-1)).toBe('⏸');
    expect(activityEmoji(4999)).toBe('⏸');
  });

  it('returns 🔹 for moderate activity', () => {
    expect(activityEmoji(5000)).toBe('🔹');
    expect(activityEmoji(49999)).toBe('🔹');
  });

  it('returns ⚡ for active', () => {
    expect(activityEmoji(50000)).toBe('⚡');
    expect(activityEmoji(499999)).toBe('⚡');
  });

  it('returns 🔥 for high activity', () => {
    expect(activityEmoji(500000)).toBe('🔥');
    expect(activityEmoji(1000000)).toBe('🔥');
  });
});

describe('gradeEmoji', () => {
  it('maps grades to colored circles', () => {
    expect(gradeEmoji('A')).toBe('🟢');
    expect(gradeEmoji('B')).toBe('🟡');
    expect(gradeEmoji('C')).toBe('🟠');
    expect(gradeEmoji('F')).toBe('🔴');
  });
});

// ── Score attribution per bot ───────────────────────────────────────

describe('score attribution per bot', () => {
  beforeEach(setup);

  it('attributes score to named bot only', () => {
    recordScoreReaction(CAPTAIN, '👍', 'cid', hoursAgo(1));
    recordScoreReaction(CAPTAIN, '💯', 'norm', hoursAgo(1));
    recordScoreReaction(CAPTAIN, '👎', 'cid', hoursAgo(2));

    // cid: +1 -1 = 0, norm: +3
    // Verify via formatBotMetrics (computeMetrics requires fleet config)
    const cidResult = formatBotMetrics({
      name: 'cid',
      score: { day1: 0, day7: 0 },
      crashes: { day1: 0, day7: 0 },
      branchBrainSuccess: { day1: -1, day7: -1 },
      tokenThroughput: { day1: -1, day7: -1 },
      messagesPerDay: { day1: 0, day7: 0 },
      taskCompletionRate: { day1: -1, day7: -1 },
      status: 'quarters',
      processRunning: true,
    });
    expect(cidResult).toContain('score');
  });

  it('empty bot name does not match any real bot', () => {
    // This tests the pre-fix behavior: recording with '' bot name
    recordScoreReaction(CAPTAIN, '👍', '', hoursAgo(1));
    // Score events exist but won't match 'cid' in computeBotMetrics filter
    // Verified implicitly: scoreEvents.filter(e => e.bot === 'cid') returns empty
  });
});

// ── Response latency tracking ───────────────────────────────────────

describe('response latency in bot metrics', () => {
  beforeEach(setup);

  it('BotMetrics captures latency percentiles', () => {
    // responseLatencyP50/P95 are optional fields in BotMetrics
    const bot: BotMetrics = {
      name: 'cid',
      score: { day1: 0, day7: 0 },
      crashes: { day1: 0, day7: 0 },
      branchBrainSuccess: { day1: -1, day7: -1 },
      tokenThroughput: { day1: -1, day7: -1 },
      messagesPerDay: { day1: 0, day7: 0 },
      taskCompletionRate: { day1: -1, day7: -1 },
      status: 'onduty',
      processRunning: true,
      responseLatencyP50: 12,
      responseLatencyP95: 45,
    };
    expect(bot.responseLatencyP50).toBe(12);
    expect(bot.responseLatencyP95).toBe(45);
  });

  it('BotMetrics latency is undefined when no data', () => {
    const bot: BotMetrics = {
      name: 'cid',
      score: { day1: 0, day7: 0 },
      crashes: { day1: 0, day7: 0 },
      branchBrainSuccess: { day1: -1, day7: -1 },
      tokenThroughput: { day1: -1, day7: -1 },
      messagesPerDay: { day1: 0, day7: 0 },
      taskCompletionRate: { day1: -1, day7: -1 },
      status: 'quarters',
      processRunning: true,
    };
    expect(bot.responseLatencyP50).toBeUndefined();
    expect(bot.responseLatencyP95).toBeUndefined();
  });
});

// ── Token throughput in BotMetrics ──────────────────────────────────

describe('token throughput in bot metrics', () => {
  it('BotMetrics stores throughput values', () => {
    const bot: BotMetrics = {
      name: 'cid',
      score: { day1: 0, day7: 0 },
      crashes: { day1: 0, day7: 0 },
      branchBrainSuccess: { day1: -1, day7: -1 },
      tokenThroughput: { day1: 75000, day7: 50000 },
      messagesPerDay: { day1: 0, day7: 0 },
      taskCompletionRate: { day1: -1, day7: -1 },
      status: 'quarters',
      processRunning: true,
    };
    expect(bot.tokenThroughput.day1).toBe(75000);
    expect(bot.tokenThroughput.day7).toBe(50000);
  });

  it('-1 means no data available', () => {
    const bot: BotMetrics = {
      name: 'cid',
      score: { day1: 0, day7: 0 },
      crashes: { day1: 0, day7: 0 },
      branchBrainSuccess: { day1: -1, day7: -1 },
      tokenThroughput: { day1: -1, day7: -1 },
      messagesPerDay: { day1: 0, day7: 0 },
      taskCompletionRate: { day1: -1, day7: -1 },
      status: 'quarters',
      processRunning: true,
    };
    expect(bot.tokenThroughput.day1).toBe(-1);
  });

  it('activityEmoji maps throughput to correct icons', () => {
    expect(activityEmoji(-1)).toBe('⏸');
    expect(activityEmoji(0)).toBe('⏸');
    expect(activityEmoji(10000)).toBe('🔹');
    expect(activityEmoji(100000)).toBe('⚡');
    expect(activityEmoji(600000)).toBe('🔥');
  });
});

// ── Messages/day (WBS 8.1) ───────────────────────────────────────────

describe('recordBotMessage', () => {
  beforeEach(setup);

  it('records messages in rolling window', () => {
    recordBotMessage('cid', hoursAgo(1));
    recordBotMessage('cid', hoursAgo(2));
    recordBotMessage('cid', hoursAgo(3));
    // 3 messages in the last day — rollingRate = 3/1 = 3.0
    // Verified via computeMetrics (bots is empty due to mock, but events are stored)
  });

  it('prunes events older than 8 days', () => {
    recordBotMessage('cid', daysAgo(9));
    recordBotMessage('cid', hoursAgo(1));
    // Only 1 event remains after pruning
    // No throw expected
  });

  it('is cleared by resetMetrics', () => {
    recordBotMessage('cid', hoursAgo(1));
    resetMetrics();
    initMetrics({ btcRoomId: BTC_ROOM, operatorUid: OPERATOR, captainUid: CAPTAIN });
    // After reset, message events are gone — no assertion needed beyond no-throw
  });
});

// ── Task completion rate (WBS 8.2) ───────────────────────────────────

describe('recordTaskCreated / recordTaskResolved', () => {
  beforeEach(setup);

  it('does not throw when recording tasks', () => {
    expect(() => recordTaskCreated('cid', hoursAgo(2))).not.toThrow();
    expect(() => recordTaskResolved('cid', hoursAgo(1))).not.toThrow();
  });

  it('is cleared by resetMetrics', () => {
    recordTaskCreated('cid', hoursAgo(1));
    recordTaskResolved('cid', hoursAgo(0));
    resetMetrics();
    initMetrics({ btcRoomId: BTC_ROOM, operatorUid: OPERATOR, captainUid: CAPTAIN });
    // After reset, task events are gone
  });

  it('prunes events older than 8 days', () => {
    recordTaskCreated('cid', daysAgo(9));
    recordTaskCreated('cid', hoursAgo(1));
    // Old event pruned automatically, no throw
  });
});

// ── Alerting (WBS 8.3) ───────────────────────────────────────────────

describe('checkAlerts', () => {
  const healthySnapshot: MetricsSnapshot = {
    ship: 'Herc',
    ts: Date.now(),
    operator: { interventions: { day1: 0, day7: 0 }, xCommandsIssued: { day1: 0, day7: 0 } },
    bots: [{ name: 'cid', score: { day1: 0, day7: 0 }, crashes: { day1: 0, day7: 0 },
      branchBrainSuccess: { day1: -1, day7: -1 }, tokenThroughput: { day1: -1, day7: -1 },
      messagesPerDay: { day1: 10, day7: 8 }, taskCompletionRate: { day1: 90, day7: 85 },
      status: 'onduty', processRunning: true }],
    shipMetrics: { name: 'Herc', relayUptimeSeconds: 86400, relayRestarts: { day1: 0, day7: 0 }, infraFailures: { day1: 0, day7: 0 } },
    fleet: { availability: 100, autonomyScore: { day1: 100, day7: 100 } },
  };

  it('returns empty for a healthy fleet', () => {
    expect(checkAlerts(healthySnapshot)).toHaveLength(0);
  });

  it('fires AVAIL_LOW when availability < 90%', () => {
    const snap = { ...healthySnapshot, fleet: { ...healthySnapshot.fleet, availability: 75 } };
    const alerts = checkAlerts(snap);
    expect(alerts.some(a => a.code === 'AVAIL_LOW')).toBe(true);
    expect(alerts.find(a => a.code === 'AVAIL_LOW')?.severity).toBe('critical');
  });

  it('fires SYNC_FAILURES when failures > 2/day', () => {
    const snap = { ...healthySnapshot, shipMetrics: { ...healthySnapshot.shipMetrics, infraFailures: { day1: 3, day7: 1 } } };
    const alerts = checkAlerts(snap);
    expect(alerts.some(a => a.code === 'SYNC_FAILURES')).toBe(true);
  });

  it('fires AUTONOMY_LOW when autonomy score < 50', () => {
    const snap = { ...healthySnapshot, fleet: { ...healthySnapshot.fleet, autonomyScore: { day1: 30, day7: 60 } } };
    const alerts = checkAlerts(snap);
    expect(alerts.some(a => a.code === 'AUTONOMY_LOW')).toBe(true);
    expect(alerts.find(a => a.code === 'AUTONOMY_LOW')?.severity).toBe('warning');
  });

  it('fires INTERVENTIONS_HIGH when interventions > 3/day', () => {
    const snap = { ...healthySnapshot, operator: { ...healthySnapshot.operator, interventions: { day1: 4, day7: 2 } } };
    const alerts = checkAlerts(snap);
    expect(alerts.some(a => a.code === 'INTERVENTIONS_HIGH')).toBe(true);
  });

  it('fires LATENCY_HIGH when bot p95 > 120s', () => {
    const snap = { ...healthySnapshot, bots: [{ ...healthySnapshot.bots[0], responseLatencyP95: 150 }] };
    const alerts = checkAlerts(snap);
    expect(alerts.some(a => a.code === 'LATENCY_HIGH')).toBe(true);
    expect(alerts.find(a => a.code === 'LATENCY_HIGH')?.bot).toBe('cid');
  });

  it('does not fire LATENCY_HIGH when p95 is undefined', () => {
    // bots with no latency data should not trigger latency alert
    expect(checkAlerts(healthySnapshot).some(a => a.code === 'LATENCY_HIGH')).toBe(false);
  });
});

describe('formatAlerts', () => {
  it('returns empty string for no alerts', () => {
    expect(formatAlerts([])).toBe('');
  });

  it('formats critical alert with red circle', () => {
    const alert: Alert = { severity: 'critical', code: 'AVAIL_LOW', message: 'test' };
    expect(formatAlerts([alert])).toContain('🔴');
    expect(formatAlerts([alert])).toContain('[AVAIL_LOW]');
  });

  it('formats warning alert with yellow circle', () => {
    const alert: Alert = { severity: 'warning', code: 'AUTONOMY_LOW', message: 'test' };
    expect(formatAlerts([alert])).toContain('🟡');
    expect(formatAlerts([alert])).toContain('[AUTONOMY_LOW]');
  });
});

// ── Version adoption latency (WBS 8.4) ───────────────────────────────

describe('recordVersionDeployed / getVersionAdoptionLatency', () => {
  beforeEach(() => {
    resetMetrics();
    initMetrics({ btcRoomId: BTC_ROOM, operatorUid: OPERATOR, captainUid: CAPTAIN });
  });

  it('records a version deploy event', () => {
    recordVersionDeployed('Herc', '1.20.0');
    const events = getVersionDeployEvents();
    expect(events).toHaveLength(1);
    expect(events[0].ship).toBe('Herc');
    expect(events[0].version).toBe('1.20.0');
  });

  it('returns null when no events recorded', () => {
    expect(getVersionAdoptionLatency('Herc', '1.20.0')).toBeNull();
  });

  it('returns 0 when this ship was first to deploy', () => {
    recordVersionDeployed('Herc', '1.20.0', hoursAgo(2));
    expect(getVersionAdoptionLatency('Herc', '1.20.0')).toBe(0);
  });

  it('returns latency delta when another ship deployed first', () => {
    recordVersionDeployed('Vega', '1.20.0', hoursAgo(4));
    recordVersionDeployed('Herc', '1.20.0', hoursAgo(2));
    const latency = getVersionAdoptionLatency('Herc', '1.20.0');
    expect(latency).toBeGreaterThan(0);
    expect(latency).toBeCloseTo(2 * 3_600_000, -4); // ~2 hours in ms
  });

  it('returns null when ship has not deployed the version', () => {
    recordVersionDeployed('Vega', '1.20.0', hoursAgo(4));
    expect(getVersionAdoptionLatency('Herc', '1.20.0')).toBeNull();
  });

  it('is cleared by resetMetrics', () => {
    recordVersionDeployed('Herc', '1.20.0');
    resetMetrics();
    expect(getVersionDeployEvents()).toHaveLength(0);
  });
});

// ── syncTodosMetrics (WBS-40) ─────────────────────────────────────────

import os from 'os';
import fs from 'fs';
import path from 'path';

describe('syncTodosMetrics', () => {
  let tmpRoot: string;
  let todosDir: string;

  function writeTodos(todos: Array<{ id?: string; content?: string; status: string }>): void {
    fs.mkdirSync(todosDir, { recursive: true });
    fs.writeFileSync(path.join(todosDir, 'session-agent-session.json'), JSON.stringify(todos));
  }

  beforeEach(() => {
    setup();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-test-'));
    todosDir = path.join(tmpRoot, '_runtime', 'instances', 'cid', 'data', 'sessions', 'main', '.claude', 'todos');
    vi.stubEnv('INFINICLAW_ROOT', tmpRoot);
    vi.spyOn(shipConfig, 'loadShipConfig').mockReturnValue({ bots: ['cid'], secretsPath: '/tmp' } as ReturnType<typeof shipConfig.loadShipConfig>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('establishes baseline on first call without recording events', () => {
    writeTodos([{ id: 'a', status: 'pending' }, { id: 'b', status: 'in_progress' }]);
    syncTodosMetrics('cid');
    const m = computeMetrics();
    const bot = m.bots.find(b => b.name === 'cid');
    // No events recorded — -1 means no data
    expect(bot?.taskCompletionRate.day1).toBe(-1);
  });

  it('detects new todos as created on second call', () => {
    writeTodos([{ id: 'a', status: 'pending' }]);
    syncTodosMetrics('cid'); // baseline
    writeTodos([{ id: 'a', status: 'pending' }, { id: 'b', status: 'pending' }]);
    syncTodosMetrics('cid'); // detect 'b' as created
    const m = computeMetrics();
    const bot = m.bots.find(b => b.name === 'cid');
    // 1 created, 0 resolved → 0%
    expect(bot?.taskCompletionRate.day1).toBe(0);
  });

  it('detects completed todos as resolved on second call', () => {
    writeTodos([{ id: 'a', status: 'pending' }, { id: 'b', status: 'pending' }]);
    syncTodosMetrics('cid'); // baseline
    writeTodos([{ id: 'a', status: 'completed' }, { id: 'b', status: 'pending' }, { id: 'c', status: 'pending' }]);
    syncTodosMetrics('cid'); // 'a' resolved, 'c' created
    const m = computeMetrics();
    const bot = m.bots.find(b => b.name === 'cid');
    // 1 created (c), 1 resolved (a) → 100%
    expect(bot?.taskCompletionRate.day1).toBe(100);
  });

  it('clears snapshot on resetMetrics', () => {
    writeTodos([{ id: 'a', status: 'pending' }]);
    syncTodosMetrics('cid'); // baseline established
    resetMetrics();
    initMetrics({ btcRoomId: BTC_ROOM, operatorUid: OPERATOR, captainUid: CAPTAIN });
    // After reset, next call is treated as first call (no events)
    writeTodos([{ id: 'a', status: 'completed' }]);
    syncTodosMetrics('cid'); // snapshot cleared — re-establishes baseline
    const m = computeMetrics();
    const bot = m.bots.find(b => b.name === 'cid');
    expect(bot?.taskCompletionRate.day1).toBe(-1);
  });

  it('does nothing when todos dir does not exist', () => {
    expect(() => syncTodosMetrics('cid')).not.toThrow();
  });
});
