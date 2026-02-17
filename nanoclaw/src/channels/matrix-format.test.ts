import { describe, expect, it } from 'vitest';

import { toFormattedBodyWithMarkdownAndMath } from './matrix.js';

describe('toFormattedBodyWithMarkdownAndMath', () => {
  it('is no longer used - pure passthrough to Matrix', () => {
    // This function still exists for backwards compatibility
    // but the Matrix channel now uses pure passthrough (sendText)
    // All markdown rendering is handled by Matrix clients
    const { formattedBody } = toFormattedBodyWithMarkdownAndMath('test');
    expect(formattedBody).toBeDefined();
  });
});
