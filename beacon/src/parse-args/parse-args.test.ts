import { describe, expect, it } from 'vitest';

import { parseArgs } from './parse-args.js';

describe('parseArgs', () => {
  it('parses keyed and boolean flags', () => {
    expect(parseArgs(['--fleet', 'OGIC', '--apply'])).toEqual({
      fleet: 'OGIC',
      apply: true,
    });
  });
});
