import { describe, it, expect } from 'vitest';

import { restoreMentionPrefixes, pillifyMentions } from '../channels/matrix.js';

// --- restoreMentionPrefixes (inbound: pill → @Name) ---

describe('restoreMentionPrefixes', () => {
  it('restores @ prefix from a single mention pill', () => {
    const body = 'Cid hello';
    const html = '<a href="https://matrix.to/#/@cid:a-gis.org">Cid</a> hello';
    expect(restoreMentionPrefixes(body, html)).toBe('@Cid hello');
  });

  it('restores multiple mention pills', () => {
    const body = 'Cid and Nora please review';
    const html =
      '<a href="https://matrix.to/#/@cid:a-gis.org">Cid</a> and ' +
      '<a href="https://matrix.to/#/@nora:a-gis.org">Nora</a> please review';
    expect(restoreMentionPrefixes(body, html)).toBe('@Cid and @Nora please review');
  });

  it('does not double-prefix names already starting with @', () => {
    const body = '@Cid hello';
    const html = '<a href="https://matrix.to/#/@cid:a-gis.org">Cid</a> hello';
    expect(restoreMentionPrefixes(body, html)).toBe('@Cid hello');
  });

  it('returns body unchanged when no mention pills in HTML', () => {
    const body = 'hello everyone';
    const html = 'hello everyone';
    expect(restoreMentionPrefixes(body, html)).toBe('hello everyone');
  });

  it('returns body unchanged when formattedBody is empty', () => {
    expect(restoreMentionPrefixes('hello', '')).toBe('hello');
  });

  it('handles mention at end of message', () => {
    const body = 'hey Cid';
    const html = 'hey <a href="https://matrix.to/#/@cid:a-gis.org">Cid</a>';
    expect(restoreMentionPrefixes(body, html)).toBe('hey @Cid');
  });

  it('handles display names with special regex characters', () => {
    const body = 'C.I.D hello';
    const html = '<a href="https://matrix.to/#/@cid:a-gis.org">C.I.D</a> hello';
    expect(restoreMentionPrefixes(body, html)).toBe('@C.I.D hello');
  });

  it('does not prefix partial name matches', () => {
    const body = 'Cider is good, Cid';
    const html = '<a href="https://matrix.to/#/@cid:a-gis.org">Cid</a>';
    const result = restoreMentionPrefixes(body, html);
    // "Cid" should get prefixed, "Cider" should not
    expect(result).toContain('@Cid');
    expect(result).not.toContain('@Cider');
  });

  it('ignores non-matrix.to links in HTML', () => {
    const body = 'check https://example.com Bob';
    const html = '<a href="https://example.com">check</a> Bob';
    expect(restoreMentionPrefixes(body, html)).toBe('check https://example.com Bob');
  });
});

// --- pillifyMentions (outbound: @Name → pill) ---

function makeCache(entries: [string, string][]): Map<string, string> {
  return new Map(entries);
}

describe('pillifyMentions', () => {
  const cache = makeCache([
    ['@cid:a-gis.org', 'Cid 🟢 (HERACLES)'],
    ['@nora:a-gis.org', 'Nora 💤 (POSEIDON)'],
    ['@operator:a-gis.org', 'operator'],
  ]);

  it('converts @Name to a mention pill', () => {
    const html = '<p>@Cid hello</p>';
    const result = pillifyMentions(html, cache);
    expect(result).toContain('href="https://matrix.to/#/@cid:a-gis.org"');
    expect(result).toContain('>Cid</a>');
    expect(result).not.toContain('@Cid');
  });

  it('is case-insensitive on name match', () => {
    const result = pillifyMentions('@cid status', cache);
    expect(result).toContain('href="https://matrix.to/#/@cid:a-gis.org"');
  });

  it('converts multiple mentions in same message', () => {
    const result = pillifyMentions('@Cid and @Nora', cache);
    expect(result).toContain('@cid:a-gis.org');
    expect(result).toContain('@nora:a-gis.org');
  });

  it('does not pillify unknown names', () => {
    const result = pillifyMentions('@Unknown hello', cache);
    expect(result).toBe('@Unknown hello');
  });

  it('does not pillify names inside existing anchor tags', () => {
    const html = '<a href="https://matrix.to/#/@cid:a-gis.org">Cid</a> said @Nora';
    const result = pillifyMentions(html, cache);
    // The existing Cid pill should be untouched
    expect(result).toContain('<a href="https://matrix.to/#/@cid:a-gis.org">Cid</a>');
    // Nora should be pillified
    expect(result).toContain('href="https://matrix.to/#/@nora:a-gis.org"');
  });

  it('does not pillify names inside href attributes', () => {
    const html = '<a href="https://example.com/@cid/profile">profile</a>';
    const result = pillifyMentions(html, cache);
    // Should be completely unchanged — @cid is inside an <a> tag attribute
    expect(result).toBe(html);
  });

  it('returns html unchanged when no @ present', () => {
    const html = '<p>hello world</p>';
    expect(pillifyMentions(html, cache)).toBe(html);
  });

  it('returns html unchanged with empty cache', () => {
    const html = '@Cid hello';
    expect(pillifyMentions(html, new Map())).toBe(html);
  });

  it('handles display names with pips — matches base name only', () => {
    // "Cid 🟢 (HERACLES)" in cache → @Cid should match
    const result = pillifyMentions('@Cid reporting', cache);
    expect(result).toContain('href="https://matrix.to/#/@cid:a-gis.org"');
    expect(result).toContain('>Cid</a>');
  });

  it('does not match partial names', () => {
    const result = pillifyMentions('@Cidney hello', cache);
    // "Cidney" should NOT match "Cid"
    expect(result).toBe('@Cidney hello');
  });

  it('handles HTML with nested tags', () => {
    const html = '<p><strong>@Cid</strong> can you check this?</p>';
    const result = pillifyMentions(html, cache);
    expect(result).toContain('href="https://matrix.to/#/@cid:a-gis.org"');
  });

  it('handles @operator mention', () => {
    const result = pillifyMentions('@operator help', cache);
    expect(result).toContain('href="https://matrix.to/#/@operator:a-gis.org"');
    expect(result).toContain('>operator</a>');
  });

  it('handles mentions in code blocks — still pillifies (code is text node)', () => {
    // In practice code blocks come through as <pre><code>@Cid</code></pre>
    // The @Cid is a text node inside <code>, not inside <a>, so it gets pillified.
    // This is acceptable — code blocks in Matrix chat context rarely contain literal @mentions.
    const html = '<pre><code>@Cid</code></pre>';
    const result = pillifyMentions(html, cache);
    expect(result).toContain('href="https://matrix.to/#/@cid:a-gis.org"');
  });

  it('escapes special characters in userId for HTML safety', () => {
    const evilCache = makeCache([
      ['@evil"><script>:server', 'Evil'],
    ]);
    const result = pillifyMentions('@Evil hi', evilCache);
    expect(result).not.toContain('<script>');
    expect(result).toContain('&gt;');
  });
});
