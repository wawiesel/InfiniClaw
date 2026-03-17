/**
 * Integration tests for unified display format.
 *
 * These tests enforce design goals from docs/design/05-bot.md.
 * If a test fails, a designed behavior has regressed.
 *
 * Design contract: every bot display includes role, rank, health, activity, and version.
 * Design contract: short format = emojis only, long format = emoji[value] with interpuncts.
 * Design contract: field order is prefix > name > role > rank > health > activity.
 */

import { describe, it, expect } from 'vitest';
import {
  unifiedBotDisplay,
  unifiedShipDisplay,
  rankMedal,
  activityEmoji,
  type UnifiedBotDisplayParams,
} from '../formatting.js';

// --- Design: 05-bot.md §Unified Display Format ---

describe('design: unified bot display — short format', () => {
  const base: UnifiedBotDisplayParams = {
    name: 'cid',
    shipEmoji: '🦁',
    locationEmoji: '🏠',
    health: 'A',
    tokPerDay: 100_000,
    status: 'quarters',
    role: 'engineer',
    rank: 2,
    isChief: false,
  };

  it('includes bot name (capitalized)', () => {
    const result = unifiedBotDisplay(base, 'short');
    expect(result).toContain('Cid');
  });

  it('includes ship emoji prefix', () => {
    const result = unifiedBotDisplay(base, 'short');
    expect(result).toMatch(/^🦁/);
  });

  it('includes location emoji', () => {
    const result = unifiedBotDisplay(base, 'short');
    expect(result).toContain('🏠');
  });

  it('includes role icon', () => {
    const result = unifiedBotDisplay(base, 'short');
    expect(result).toContain('⚙️'); // engineer icon
  });

  it('includes rank medal', () => {
    const result = unifiedBotDisplay(base, 'short');
    expect(result).toContain('🥈'); // rank 2
  });

  it('includes health emoji', () => {
    const result = unifiedBotDisplay(base, 'short');
    expect(result).toContain('🟢'); // grade A
  });

  it('includes activity emoji', () => {
    const result = unifiedBotDisplay(base, 'short');
    expect(result).toContain('⚡'); // 100K tok/day = moderate
  });

  it('includes version when provided', () => {
    const result = unifiedBotDisplay({ ...base, version: 'v1.3.14' }, 'short');
    expect(result).toContain('v1.3.14');
  });

  it('sleeping bot shows 💤 not health grade emoji', () => {
    const result = unifiedBotDisplay({ ...base, status: 'sleep' }, 'short');
    expect(result).toContain('💤');
    // Should NOT show 🟢 for sleep status
    expect(result).not.toContain('🟢');
  });

  it('field order: prefix > name > role > rank > health > activity', () => {
    const result = unifiedBotDisplay(base, 'short');
    const prefixIdx = result.indexOf('🦁');
    const nameIdx = result.indexOf('Cid');
    const roleIdx = result.indexOf('⚙️');
    const rankIdx = result.indexOf('🥈');
    const healthIdx = result.indexOf('🟢');
    const actIdx = result.indexOf('⚡');
    expect(prefixIdx).toBeLessThan(nameIdx);
    expect(nameIdx).toBeLessThan(roleIdx);
    expect(roleIdx).toBeLessThan(rankIdx);
    expect(rankIdx).toBeLessThan(healthIdx);
    expect(healthIdx).toBeLessThan(actIdx);
  });
});

describe('design: unified bot display — long format', () => {
  const base: UnifiedBotDisplayParams = {
    name: 'tali',
    shipEmoji: '🦁',
    locationEmoji: '🏠',
    health: 'A',
    tokPerDay: 16_000,
    status: 'quarters',
    role: 'engineer',
    rank: 2,
    isChief: false,
  };

  it('long format uses interpuncts between fields', () => {
    const result = unifiedBotDisplay(base, 'long');
    expect(result).toContain('·');
  });

  it('long format shows values in brackets', () => {
    const result = unifiedBotDisplay(base, 'long');
    expect(result).toMatch(/\[.*\]/); // at least one bracketed value
  });

  it('long format shows tok/d', () => {
    const result = unifiedBotDisplay(base, 'long');
    expect(result).toContain('tok/d');
  });
});

describe('design: unified ship display', () => {
  it('short format includes speaker star', () => {
    const result = unifiedShipDisplay({
      name: 'Herc', emoji: '🦁', typeEmoji: '🛳️', type: 'cruiser',
      health: 'A', tokPerDay: 32_000,
      isSpeaker: true, commissioned: true, rank: 1,
    }, 'short');
    expect(result).toContain('⭐');
  });

  it('short format shows rank medal for non-speaker', () => {
    const result = unifiedShipDisplay({
      name: 'Posi', emoji: '🔱', typeEmoji: '🛳️', type: 'cruiser',
      health: 'B', tokPerDay: 50_000,
      isSpeaker: false, commissioned: true, rank: 2,
    }, 'short');
    expect(result).toContain('🥈'); // rank 2 medal
  });

  it('decommissioned ship shows 💤', () => {
    const result = unifiedShipDisplay({
      name: 'Herm', emoji: '🪽', typeEmoji: '🛳️', type: 'destroyer',
      health: 'A', tokPerDay: 0,
      isSpeaker: false, commissioned: false, rank: 3,
    }, 'short');
    expect(result).toContain('💤');
  });
});

// --- Design: 05-bot.md §Rank Medals ---

describe('design: rank medals', () => {
  it('chief gets ⭐', () => {
    expect(rankMedal(1, true)).toBe('⭐');
  });

  it('rank 1 non-chief gets 🥇', () => {
    expect(rankMedal(1, false)).toBe('🥇');
  });

  it('rank 2 gets 🥈', () => {
    expect(rankMedal(2, false)).toBe('🥈');
  });

  it('rank 3+ gets 🥉', () => {
    expect(rankMedal(3, false)).toBe('🥉');
    expect(rankMedal(5, false)).toBe('🥉');
  });
});

// --- Design: 05-bot.md §Activity Levels ---

describe('design: activity levels', () => {
  it('0 tok/day = idle', () => {
    const emoji = activityEmoji(0);
    expect(emoji).toBeTruthy(); // design says idle has an emoji (⏸ or ·)
  });

  it('10K tok/day = low (🔹)', () => {
    expect(activityEmoji(10_000)).toBe('🔹');
  });

  it('100K tok/day = moderate (⚡)', () => {
    expect(activityEmoji(100_000)).toBe('⚡');
  });

  it('600K tok/day = high (🔥)', () => {
    expect(activityEmoji(600_000)).toBe('🔥');
  });
});

// --- Design: version must be present when provided ---

describe('design: version display', () => {
  it('version appears in short format when provided', () => {
    const result = unifiedBotDisplay({
      name: 'parker', shipEmoji: '🔱', locationEmoji: '⚙️',
      health: 'A', tokPerDay: 50_000, status: 'onduty',
      role: 'engineer', rank: 1, isChief: true,
      version: 'v1.3.14',
    }, 'short');
    expect(result).toContain('v1.3.14');
    expect(result).toContain('Parker');
  });

  it('version appears in long format when provided', () => {
    const result = unifiedBotDisplay({
      name: 'parker', shipEmoji: '🔱', locationEmoji: '⚙️',
      health: 'A', tokPerDay: 50_000, status: 'onduty',
      role: 'engineer', rank: 1, isChief: true,
      version: 'v1.3.14',
    }, 'long');
    expect(result).toContain('v1.3.14');
  });

  it('no version = no extra text after name', () => {
    const withVersion = unifiedBotDisplay({
      name: 'cid', shipEmoji: '', locationEmoji: '',
      health: '', tokPerDay: 0, status: 'sleep',
      role: 'engineer', rank: 2, isChief: false,
      version: 'v1.3.14',
    }, 'short');
    const without = unifiedBotDisplay({
      name: 'cid', shipEmoji: '', locationEmoji: '',
      health: '', tokPerDay: 0, status: 'sleep',
      role: 'engineer', rank: 2, isChief: false,
    }, 'short');
    expect(withVersion).toContain('v1.3.14');
    expect(without).not.toContain('v1.3');
  });
});
