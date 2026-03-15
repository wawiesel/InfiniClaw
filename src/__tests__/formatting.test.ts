import { describe, it, expect } from 'vitest';
import {
  rankMedal,
  botBadge,
  botTreeLine,
  unifiedBotDisplay,
  type UnifiedBotDisplayParams,
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
  shipName: 'Herc',
  locationEmoji: '⚙️',
  locationShort: 'Eng',
  locationFull: 'Engineering',
  health: 'A',
  activity: 'active',
  role: 'engineer',
  rank: 1,
  isChief: false,
};

describe('unifiedBotDisplay — short', () => {
  it('contains ship emoji only (no name)', () => {
    const out = unifiedBotDisplay(BASE, 'short');
    expect(out).toContain('🦁');
    expect(out).not.toContain('Herc');
  });

  it('contains role icon and rank medal', () => {
    const out = unifiedBotDisplay(BASE, 'short');
    expect(out).toContain('🥇');
  });

  it('contains health emoji', () => {
    const out = unifiedBotDisplay(BASE, 'short');
    expect(out).toContain('🟢');
  });

  it('contains activity fire when active', () => {
    const out = unifiedBotDisplay(BASE, 'short');
    expect(out).toContain('🔥');
  });

  it('no fire when idle', () => {
    const out = unifiedBotDisplay({ ...BASE, activity: '' }, 'short');
    expect(out).not.toContain('🔥');
  });

  it('chief shows ⭐ instead of rank medal', () => {
    const out = unifiedBotDisplay({ ...BASE, isChief: true }, 'short');
    expect(out).toContain('⭐');
    expect(out).not.toContain('🥇');
  });

  it('name is capitalized', () => {
    const out = unifiedBotDisplay(BASE, 'short');
    expect(out).toContain('Cid');
  });
});

describe('unifiedBotDisplay — medium', () => {
  it('contains ship emoji+name', () => {
    const out = unifiedBotDisplay(BASE, 'medium');
    expect(out).toContain('🦁Herc');
  });

  it('contains location emoji+short name', () => {
    const out = unifiedBotDisplay(BASE, 'medium');
    expect(out).toContain('⚙️Eng');
  });

  it('contains health emoji+grade letter', () => {
    const out = unifiedBotDisplay(BASE, 'medium');
    expect(out).toContain('🟢A');
  });

  it('contains activity with text', () => {
    const out = unifiedBotDisplay(BASE, 'medium');
    expect(out).toContain('🔥active');
  });

  it('contains rank number', () => {
    const out = unifiedBotDisplay(BASE, 'medium');
    expect(out).toContain('🥇1');
  });

  it('uses abbreviated role (first 3 chars)', () => {
    const out = unifiedBotDisplay(BASE, 'medium');
    expect(out).toContain('eng');
  });
});

describe('unifiedBotDisplay — long', () => {
  it('includes [ship] label', () => {
    const out = unifiedBotDisplay(BASE, 'long');
    expect(out).toContain('[ship]');
  });

  it('includes full location name and [loc] label', () => {
    const out = unifiedBotDisplay(BASE, 'long');
    expect(out).toContain('Engineering[loc]');
  });

  it('includes [health] label', () => {
    const out = unifiedBotDisplay(BASE, 'long');
    expect(out).toContain('[health]');
  });

  it('includes [activity] label when active', () => {
    const out = unifiedBotDisplay(BASE, 'long');
    expect(out).toContain('[activity]');
  });

  it('no [activity] label when idle', () => {
    const out = unifiedBotDisplay({ ...BASE, activity: '' }, 'long');
    expect(out).not.toContain('[activity]');
  });

  it('includes full role name and [role] label', () => {
    const out = unifiedBotDisplay(BASE, 'long');
    expect(out).toContain('engineer[role]');
  });

  it('includes rank1 label', () => {
    const out = unifiedBotDisplay(BASE, 'long');
    expect(out).toContain('rank1');
  });
});
