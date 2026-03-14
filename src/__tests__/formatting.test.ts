import { describe, expect, it } from 'vitest';

import { formatBotLine, type BotDisplayParams } from '../formatting.js';

/** Albert: engineer on Herc, healthy+active, rank 1 (not chief) — from spec examples. */
const albert: BotDisplayParams = {
  shipEmoji: '🦁',
  shipName:  'Herc',
  location:  'engineering',
  health:    'A',
  activity:  '🔥',
  name:      'albert',
  role:      'engineer',
  rank:      1,
  isChief:   false,
};

/** Albert as chief (on duty, lowest rank in room). */
const albertChief: BotDisplayParams = { ...albert, isChief: true };

/** Nora: navigator on Posi, sleeping, rank 2 — from spec examples. */
const nora: BotDisplayParams = {
  shipEmoji: '🔱',
  shipName:  'Posi',
  location:  'quarters',
  health:    'sleep',
  activity:  undefined,
  name:      'nora',
  role:      'navigator',
  rank:      2,
  isChief:   false,
};

describe('formatBotLine — short verbosity', () => {
  it('matches spec example: Albert, engineer, healthy+active, rank 1', () => {
    // 🦁⚙️·🟢🔥·Albert·⚙️🥇
    expect(formatBotLine(albert, 'short')).toBe('🦁⚙️·🟢🔥·Albert·⚙️🥇');
  });

  it('matches spec example: Albert, chief', () => {
    // 🦁⚙️·🟢🔥·Albert·⚙️⭐
    expect(formatBotLine(albertChief, 'short')).toBe('🦁⚙️·🟢🔥·Albert·⚙️⭐');
  });

  it('matches spec example: Nora, navigator, sleeping, rank 2', () => {
    // 🔱🏠·💤·Nora·🧭🥈
    expect(formatBotLine(nora, 'short')).toBe('🔱🏠·💤·Nora·🧭🥈');
  });

  it('idle bot has no activity marker', () => {
    const idle = { ...albert, activity: undefined };
    expect(formatBotLine(idle, 'short')).toBe('🦁⚙️·🟢·Albert·⚙️🥇');
  });

  it('rank 3+ uses 🥉', () => {
    const rank3 = { ...albert, rank: 3 };
    expect(formatBotLine(rank3, 'short')).toBe('🦁⚙️·🟢🔥·Albert·⚙️🥉');
  });

  it('architect role uses 🔭', () => {
    const arch = { ...albert, role: 'architect', location: 'astrometrics' };
    expect(formatBotLine(arch, 'short')).toBe('🦁🔭·🟢🔥·Albert·🔭🥇');
  });

  it('normie role uses 💬', () => {
    const norm = { ...albert, role: 'normie', location: 'quarters' };
    expect(formatBotLine(norm, 'short')).toBe('🦁🏠·🟢🔥·Albert·💬🥇');
  });

  it('capitalizes name', () => {
    const lower = { ...albert, name: 'cid' };
    expect(formatBotLine(lower, 'short')).toContain('·Cid·');
  });

  it('bridge location uses 🧭', () => {
    const nav = { ...albert, location: 'bridge' };
    expect(formatBotLine(nav, 'short')).toMatch(/^🦁🧭·/);
  });
});

describe('formatBotLine — medium verbosity', () => {
  it('expands all fields with abbreviated labels', () => {
    // 🦁Herc⚙️Eng·🟢A🔥active·Albert·⚙️eng🥇1
    expect(formatBotLine(albert, 'medium')).toBe('🦁Herc⚙️Eng·🟢A🔥active·Albert·⚙️eng🥇1');
  });

  it('sleeping bot: no activity', () => {
    expect(formatBotLine(nora, 'medium')).toBe('🔱Posi🏠Qtrs·💤sleep·Nora·🧭nav🥈2');
  });

  it('chief uses ⭐chief', () => {
    expect(formatBotLine(albertChief, 'medium')).toBe('🦁Herc⚙️Eng·🟢A🔥active·Albert·⚙️eng⭐chief');
  });
});

describe('formatBotLine — long verbosity', () => {
  it('expands all fields with full labels and tags', () => {
    expect(formatBotLine(albert, 'long')).toBe(
      '🦁Herc[ship]⚙️Engineering[loc]·🟢A[health]🔥active[activity]·Albert·⚙️engineer[role]🥇rank1',
    );
  });

  it('sleeping bot long format', () => {
    expect(formatBotLine(nora, 'long')).toBe(
      '🔱Posi[ship]🏠Quarters[loc]·💤sleep[health]·Nora·🧭navigator[role]🥈rank2',
    );
  });

  it('chief uses ⭐chief[rank]', () => {
    expect(formatBotLine(albertChief, 'long')).toContain('⭐chief[rank]');
  });
});

describe('formatBotLine — boot stages', () => {
  it('building stage uses 🔄', () => {
    const building = { ...albert, health: 'building', activity: undefined };
    expect(formatBotLine(building, 'short')).toContain('·🔄·');
  });

  it('starting stage uses 🚀', () => {
    const starting = { ...albert, health: 'starting', activity: undefined };
    expect(formatBotLine(starting, 'short')).toContain('·🚀·');
  });

  it('waiting stage uses 🟡', () => {
    const waiting = { ...albert, health: 'waiting', activity: undefined };
    expect(formatBotLine(waiting, 'short')).toContain('·🟡·');
  });
});
