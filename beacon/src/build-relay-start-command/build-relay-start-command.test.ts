import { describe, expect, it } from 'vitest';

import { defaultBootstrapInput } from '../default-bootstrap-input/default-bootstrap-input.js';
import { buildRelayStartCommand } from './build-relay-start-command.js';

describe('buildRelayStartCommand', () => {
  it('returns the expected relay start command', () => {
    const input = defaultBootstrapInput({ relayRepo: '/tmp/infiniclaw-relay' });
    expect(buildRelayStartCommand(input)).toEqual([
      'node',
      '/tmp/infiniclaw-relay/dist/cli.js',
      'relay',
      'start',
    ]);
  });
});
