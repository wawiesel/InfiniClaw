import { describe, expect, it } from 'vitest';

import { defaultBootstrapInput } from './default-bootstrap-input.js';

describe('defaultBootstrapInput', () => {
  it('fills in standard defaults', () => {
    const input = defaultBootstrapInput({ relayRepo: '/tmp/infiniclaw-relay' });
    expect(input.fleetName).toBe('OGIC');
    expect(input.emoji).toBe('🌊');
    expect(input.relayRepo).toBe('/tmp/infiniclaw-relay');
    expect(input.apply).toBe(false);
  });
});
