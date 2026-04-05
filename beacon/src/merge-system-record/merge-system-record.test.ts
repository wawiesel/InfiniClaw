import { describe, expect, it } from 'vitest';

import { defaultBootstrapInput } from '../default-bootstrap-input/default-bootstrap-input.js';
import { mergeSystemRecord } from './merge-system-record.js';

describe('mergeSystemRecord', () => {
  it('preserves an existing spaceId when none is supplied', () => {
    const input = defaultBootstrapInput({
      name: 'Poseidon',
      emoji: '🌊',
      hostname: 'mac139160',
      apply: false,
    });
    expect(mergeSystemRecord({
      name: 'Poseidon',
      emoji: '🌊',
      hostname: 'old-host',
      spaceId: '!existing:a-gis.org',
    }, input)).toEqual({
      name: 'Poseidon',
      emoji: '🌊',
      hostname: 'mac139160',
      spaceId: '!existing:a-gis.org',
    });
  });
});
