import { describe, expect, it } from 'vitest';

import { botShouldWriteStartupDisplayName, relayShouldWriteWakeDisplayName } from '../display-name-policy.js';

describe('display name startup policy', () => {
  it('keeps wake lifecycle ownership in one relay final write', () => {
    expect(relayShouldWriteWakeDisplayName('building')).toBe(false);
    expect(relayShouldWriteWakeDisplayName('starting')).toBe(false);
    expect(relayShouldWriteWakeDisplayName('waiting')).toBe(false);
    expect(relayShouldWriteWakeDisplayName('online')).toBe(true);
  });

  it('prevents bot startup from racing relay display updates', () => {
    expect(botShouldWriteStartupDisplayName()).toBe(false);
  });
});
