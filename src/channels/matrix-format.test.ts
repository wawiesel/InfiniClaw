import { describe, expect, it } from 'vitest';

import { toFormattedBodyWithMarkdownAndMath } from './matrix.js';

describe('toFormattedBodyWithMarkdownAndMath', () => {
  it('renders inline code', () => {
    const { formattedBody, hasRichFormatting } = toFormattedBodyWithMarkdownAndMath(
      'use `const x = 1` here',
    );
    expect(formattedBody).toContain('<code>const x = 1</code>');
    expect(hasRichFormatting).toBe(true);
  });

  it('renders fenced code blocks', () => {
    const { formattedBody, hasRichFormatting } = toFormattedBodyWithMarkdownAndMath(
      '```ts\nconst x = 1 < 2;\n```',
    );
    expect(formattedBody).toContain('<pre><code>');
    expect(formattedBody).toContain('const x');
    expect(hasRichFormatting).toBe(true);
  });

  it('renders matrix math spans and blocks', () => {
    const { formattedBody } = toFormattedBodyWithMarkdownAndMath(
      'inline $x^2$ and $$y=mx+b$$',
    );
    expect(formattedBody).toContain('data-mx-maths="x^2"');
    expect(formattedBody).toContain('data-mx-maths="y=mx+b"');
  });

  it('returns hasRichFormatting=false for plain text', () => {
    const { hasRichFormatting } = toFormattedBodyWithMarkdownAndMath('hello world');
    expect(hasRichFormatting).toBe(false);
  });
});
