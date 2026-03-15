import { describe, it, expect } from 'vitest';
import {
  rankMedal,
  botBadge,
  botTreeLine,
  unifiedBotDisplay,
  unifiedShipDisplay,
  type UnifiedBotDisplayParams,
  type UnifiedShipDisplayParams,
} from '../formatting.js';

// ── rankMedal ──────────────────────────────────────────────────────

describe('rankMedal', () => {
  it('returns ⭐ for chief regardless of rank', () => {
    expect(rankMedal(1, true)).toBe('⭐');
    expect(rankMedal(3, true)).toBe('⭐');
  });

  it('returns 🥇 for rank 1 non-chief', () => {
    expect(rankMedal(1, false)).toBe('🥇');
  });

  it('returns 🥈 for rank 2', () => {
    expect(rankMedal(2, false)).toBe('🥈');
  });

  it('returns 🥉 for rank 3+', () => {
    expect(rankMedal(3, false)).toBe('🥉');
    expect(rankMedal(10, false)).toBe('🥉');
  });
});

// ── botBadge ───────────────────────────────────────────────────────

describe('botBadge', () => {
  it('returns 💤 for sleep', () => {
    expect(botBadge('sleep', null)).toBe('💤');
  });

  it('returns 🚀 for transit', () => {
    expect(botBadge('transit', null)).toBe('🚀');
  });

  it('returns 🔴 when process not running', () => {
    expect(botBadge('onduty', false)).toBe('🔴');
  });

  it('returns health grade with activity', () => {
    expect(botBadge('onduty', true, 'A', '🔥')).toBe('🟢A🔥');
  });

  it('returns health grade without activity', () => {
    expect(botBadge('onduty', true, 'B')).toBe('🟡B');
  });

  it('returns ◉ when running but no grade', () => {
    expect(botBadge('onduty', null)).toBe('◉');
  });
});

// ── botTreeLine ────────────────────────────────────────────────────

describe('botTreeLine', () => {
  it('uses 🥇 medal for rank 1 non-chief', () => {
    const line = botTreeLine(false, '🟢A', 'Cid', 'Engineer', '⚙️', 1, false, '', '');
    expect(line).toContain('🥇');
    expect(line).not.toContain('⭐');
  });

  it('uses ⭐ medal for chief', () => {
    const line = botTreeLine(false, '🟢A', 'Cid', 'Engineer', '⚙️', 1, true, '', '');
    expect(line).toContain('⭐');
    expect(line).not.toContain('🥇');
  });

  it('uses └ prefix for last item', () => {
    const line = botTreeLine(true, '🟢A', 'Cid', 'Engineer', '⚙️', 1, false, '', '');
    expect(line).toContain('└');
  });

  it('uses ├ prefix for non-last item', () => {
    const line = botTreeLine(false, '🟢A', 'Cid', 'Engineer', '⚙️', 1, false, '', '');
    expect(line).toContain('├');
  });
});

// ── unifiedBotDisplay ──────────────────────────────────────────────

const BASE: UnifiedBotDisplayParams = {
  name: 'cid',
  shipEmoji: '🦁',
  locationEmoji: '⚙️',
  health: 'A',
  tokPerDay: 500_000,
  status: 'onduty',
  role: 'engineer',
  rank: 1,
  isChief: false,
};

describe('unifiedBotDisplay — short', () => {
  it('format: prefix Name roleIcon+medal+health+activity', () => {
    const out = unifiedBotDisplay(BASE, 'short');
    expect(out).toBe('🦁⚙️ Cid ⚙️🥇🟢🔥');
  });

  it('no activity emoji when idle', () => {
    const out = unifiedBotDisplay({ ...BASE, tokPerDay: 0 }, 'short');
    expect(out).not.toContain('🔥');
  });

  it('chief shows ⭐ instead of rank medal', () => {
    const out = unifiedBotDisplay({ ...BASE, isChief: true }, 'short');
    expect(out).toContain('⭐');
    expect(out).not.toContain('🥇');
  });

  it('sleep bot shows 💤 health and retains activity', () => {
    const out = unifiedBotDisplay({ ...BASE, status: 'sleep', tokPerDay: 100_000 }, 'short');
    expect(out).toContain('💤');
    expect(out).toContain('⚡');
  });

  it('moderate activity shows ⚡', () => {
    const out = unifiedBotDisplay({ ...BASE, tokPerDay: 100_000 }, 'short');
    expect(out).toContain('⚡');
  });

  it('low activity shows 🔹', () => {
    const out = unifiedBotDisplay({ ...BASE, tokPerDay: 10_000 }, 'short');
    expect(out).toContain('🔹');
  });
});

describe('unifiedBotDisplay — long', () => {
  it('format: prefix Name role·medal[rank]rank·health[grade]health·activity[tok/d]', () => {
    const out = unifiedBotDisplay(BASE, 'long');
    expect(out).toBe('🦁⚙️ Cid ⚙️engineer·🥇[1]rank·🟢[A]health·🔥[500K tok/d]');
  });

  it('includes [health] label', () => {
    const out = unifiedBotDisplay(BASE, 'long');
    expect(out).toContain('[A]health');
  });

  it('includes [rank] label', () => {
    const out = unifiedBotDisplay(BASE, 'long');
    expect(out).toContain('[1]rank');
  });

  it('includes tok/d in activity', () => {
    const out = unifiedBotDisplay(BASE, 'long');
    expect(out).toContain('[500K tok/d]');
  });

  it('no activity section when idle', () => {
    const out = unifiedBotDisplay({ ...BASE, tokPerDay: 0 }, 'long');
    expect(out).not.toContain('tok/d');
  });

  it('sleep bot shows 💤 emoji with actual health grade and retains activity', () => {
    const out = unifiedBotDisplay({ ...BASE, status: 'sleep', health: 'A', tokPerDay: 16_000 }, 'long');
    expect(out).toContain('💤[A]health');
    expect(out).toContain('🔹[16K tok/d]');
  });

  it('chief shows ⭐ medal', () => {
    const out = unifiedBotDisplay({ ...BASE, isChief: true }, 'long');
    expect(out).toContain('⭐[1]rank');
  });

  it('formats small tok as number', () => {
    const out = unifiedBotDisplay({ ...BASE, tokPerDay: 800 }, 'long');
    // 800 is below 5K threshold, no activity section
    expect(out).not.toContain('tok/d');
  });

  it('formats 5K+ tok with K suffix', () => {
    const out = unifiedBotDisplay({ ...BASE, tokPerDay: 16_000 }, 'long');
    expect(out).toContain('🔹[16K tok/d]');
  });

  it('formats 1M+ tok with M suffix', () => {
    const out = unifiedBotDisplay({ ...BASE, tokPerDay: 1_200_000 }, 'long');
    expect(out).toContain('🔥[1.2M tok/d]');
  });

  it('formats 10M+ tok as rounded M', () => {
    const out = unifiedBotDisplay({ ...BASE, tokPerDay: 39_333_000 }, 'long');
    expect(out).toContain('🔥[39M tok/d]');
  });
});

// ── unifiedShipDisplay ──────────────────────────────────────────

const SHIP_BASE: UnifiedShipDisplayParams = {
  name: 'Herc',
  emoji: '🦁',
  typeEmoji: '🛳️',
  type: 'cruiser',
  rank: 1,
  isSpeaker: true,
  commissioned: true,
  health: 'A',
  tokPerDay: 500_000,
};

describe('unifiedShipDisplay — short', () => {
  it('format: emoji Name typeEmoji+medal+health+activity', () => {
    const out = unifiedShipDisplay(SHIP_BASE, 'short');
    expect(out).toBe('🦁 Herc 🛳️⭐🟢🔥');
  });

  it('non-speaker shows rank medal', () => {
    const out = unifiedShipDisplay({ ...SHIP_BASE, isSpeaker: false, rank: 2 }, 'short');
    expect(out).toContain('🥈');
    expect(out).not.toContain('⭐');
  });

  it('decommissioned shows 💤', () => {
    const out = unifiedShipDisplay({ ...SHIP_BASE, commissioned: false }, 'short');
    expect(out).toContain('💤');
    expect(out).not.toContain('🔥');
  });
});

describe('unifiedShipDisplay — long', () => {
  it('format: emoji Name type·medal[rank]rank·health[grade]health·activity[tok/d]', () => {
    const out = unifiedShipDisplay(SHIP_BASE, 'long');
    expect(out).toBe('🦁 Herc 🛳️cruiser·⭐[1]rank·🟢[A]health·🔥[500K tok/d]');
  });

  it('non-speaker shows rank medal', () => {
    const out = unifiedShipDisplay({ ...SHIP_BASE, isSpeaker: false, rank: 2 }, 'long');
    expect(out).toContain('🥈[2]rank');
  });

  it('decommissioned shows decom health', () => {
    const out = unifiedShipDisplay({ ...SHIP_BASE, commissioned: false }, 'long');
    expect(out).toContain('💤[decom]health');
    expect(out).not.toContain('tok/d');
  });

  it('no activity when idle', () => {
    const out = unifiedShipDisplay({ ...SHIP_BASE, tokPerDay: 0 }, 'long');
    expect(out).not.toContain('tok/d');
  });
});
