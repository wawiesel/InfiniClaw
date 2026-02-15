import { describe, expect, it } from 'vitest';

import { toFormattedBodyWithMarkdownAndMath } from './matrix.js';

describe('toFormattedBodyWithMarkdownAndMath', () => {
  it('renders inline markdown formatting', () => {
    const { formattedBody, hasRichFormatting } =
      toFormattedBodyWithMarkdownAndMath(
        'This is **bold**, *italic*, `code`, and ~~gone~~.',
      );

    expect(hasRichFormatting).toBe(true);
    expect(formattedBody).toContain('<strong>bold</strong>');
    expect(formattedBody).toContain('<em>italic</em>');
    expect(formattedBody).toContain('<code>code</code>');
    expect(formattedBody).toContain('<del>gone</del>');
  });

  it('renders fenced code blocks', () => {
    const { formattedBody, hasRichFormatting } =
      toFormattedBodyWithMarkdownAndMath('```ts\nconst x = 1 < 2;\n```');

    expect(hasRichFormatting).toBe(true);
    expect(formattedBody).toContain('<pre><code>const x = 1 &lt; 2;\n</code></pre>');
  });

  it('renders links with safe schemes only', () => {
    const safe = toFormattedBodyWithMarkdownAndMath(
      'Link: [OpenAI](https://openai.com)',
    );
    const file = toFormattedBodyWithMarkdownAndMath(
      'File: [Local](file:///Users/ww5/test.txt)',
    );
    const unsafe = toFormattedBodyWithMarkdownAndMath(
      'Bad: [x](javascript:alert(1))',
    );

    expect(safe.formattedBody).toContain('<a href="https://openai.com">OpenAI</a>');
    expect(file.formattedBody).toContain('<a href="file:///Users/ww5/test.txt">Local</a>');
    expect(unsafe.formattedBody).toContain('[x](javascript:alert(1))');
  });

  it('renders matrix math spans and blocks', () => {
    const { formattedBody, hasRichFormatting } =
      toFormattedBodyWithMarkdownAndMath('inline $x^2$ and $$y=mx+b$$');

    expect(hasRichFormatting).toBe(true);
    expect(formattedBody).toContain('data-mx-maths="x^2"');
    expect(formattedBody).toContain('data-mx-maths="y=mx+b"');
  });
});
