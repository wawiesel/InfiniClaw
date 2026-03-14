import { describe, it, expect } from 'vitest';

import { restoreMentionPrefixes, pillifyMentions, convertRawMentions } from '../channels/matrix.js';

// --- restoreMentionPrefixes (inbound: pill → <m>Name</m>) ---

describe('restoreMentionPrefixes', () => {
  it('wraps mentioned name in <m> markers from a single pill', () => {
    const body = 'Cid hello';
    const html = '<a href="https://matrix.to/#/@cid:a-gis.org">Cid</a> hello';
    expect(restoreMentionPrefixes(body, html)).toBe('<m>Cid</m> hello');
  });

  it('wraps multiple mentioned names', () => {
    const body = 'Cid and Nora please review';
    const html =
      '<a href="https://matrix.to/#/@cid:a-gis.org">Cid</a> and ' +
      '<a href="https://matrix.to/#/@nora:a-gis.org">Nora</a> please review';
    expect(restoreMentionPrefixes(body, html)).toBe('<m>Cid</m> and <m>Nora</m> please review');
  });

  it('does not double-wrap names already in <m> markers', () => {
    const body = '<m>Cid</m> hello';
    const html = '<a href="https://matrix.to/#/@cid:a-gis.org">Cid</a> hello';
    expect(restoreMentionPrefixes(body, html)).toBe('<m>Cid</m> hello');
  });

  it('wraps @-prefixed names when backed by a pill', () => {
    const body = '@Cid hello';
    const html = '<a href="https://matrix.to/#/@cid:a-gis.org">Cid</a> hello';
    expect(restoreMentionPrefixes(body, html)).toBe('<m>Cid</m> hello');
  });

  it('wraps case-insensitive @name from pill', () => {
    const body = '@cid do something';
    const html = '<a href="https://matrix.to/#/@cid-bot:a-gis.org">Cid</a> do something';
    expect(restoreMentionPrefixes(body, html)).toBe('<m>Cid</m> do something');
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
    expect(restoreMentionPrefixes(body, html)).toBe('hey <m>Cid</m>');
  });

  it('handles display names with special regex characters', () => {
    const body = 'C.I.D hello';
    const html = '<a href="https://matrix.to/#/@cid:a-gis.org">C.I.D</a> hello';
    expect(restoreMentionPrefixes(body, html)).toBe('<m>C.I.D</m> hello');
  });

  it('does not wrap partial name matches', () => {
    const body = 'Cider is good, Cid';
    const html = '<a href="https://matrix.to/#/@cid:a-gis.org">Cid</a>';
    const result = restoreMentionPrefixes(body, html);
    expect(result).toContain('<m>Cid</m>');
    expect(result).not.toContain('<m>Cider</m>');
  });

  it('ignores non-matrix.to links in HTML', () => {
    const body = 'check https://example.com Bob';
    const html = '<a href="https://example.com">check</a> Bob';
    expect(restoreMentionPrefixes(body, html)).toBe('check https://example.com Bob');
  });
});

// --- pillifyMentions (outbound: <m>Name</m> → pill) ---

function makeCache(entries: [string, string][]): Map<string, string> {
  return new Map(entries);
}

describe('pillifyMentions', () => {
  const cache = makeCache([
    ['@cid:a-gis.org', 'Cid 🟢 (HERACLES)'],
    ['@nora:a-gis.org', 'Nora 💤 (POSEIDON)'],
    ['@operator:a-gis.org', 'operator'],
  ]);

  it('converts <m>Name</m> to a mention pill', () => {
    const result = pillifyMentions('<m>Cid</m> hello', cache);
    expect(result).toContain('href="https://matrix.to/#/@cid:a-gis.org"');
    expect(result).toContain('>Cid</a>');
    expect(result).not.toContain('<m>');
  });

  it('is case-insensitive on name match', () => {
    const result = pillifyMentions('<m>cid</m> status', cache);
    expect(result).toContain('href="https://matrix.to/#/@cid:a-gis.org"');
  });

  it('converts multiple markers in same message', () => {
    const result = pillifyMentions('<m>Cid</m> and <m>Nora</m>', cache);
    expect(result).toContain('@cid:a-gis.org');
    expect(result).toContain('@nora:a-gis.org');
  });

  it('strips marker for unknown names, leaving plain text', () => {
    const result = pillifyMentions('<m>Unknown</m> hello', cache);
    expect(result).toBe('Unknown hello');
    expect(result).not.toContain('<m>');
  });

  it('does not touch @Name patterns — only <m> markers', () => {
    const result = pillifyMentions('@Cid hello', cache);
    expect(result).toBe('@Cid hello');
  });

  it('returns text unchanged when no <m> marker present', () => {
    const html = '<p>hello world</p>';
    expect(pillifyMentions(html, cache)).toBe(html);
  });

  it('returns text with stripped markers when cache is empty', () => {
    const result = pillifyMentions('<m>Cid</m> hello', new Map());
    expect(result).toBe('Cid hello');
  });

  it('matches display names with pips by base name only', () => {
    const result = pillifyMentions('<m>Cid</m> reporting', cache);
    expect(result).toContain('href="https://matrix.to/#/@cid:a-gis.org"');
    expect(result).toContain('>Cid</a>');
  });

  it('handles <m>operator</m> mention', () => {
    const result = pillifyMentions('<m>operator</m> help', cache);
    expect(result).toContain('href="https://matrix.to/#/@operator:a-gis.org"');
    expect(result).toContain('>operator</a>');
  });

  it('works inside HTML tags', () => {
    const html = '<p><strong><m>Cid</m></strong> can you check?</p>';
    const result = pillifyMentions(html, cache);
    expect(result).toContain('href="https://matrix.to/#/@cid:a-gis.org"');
    expect(result).not.toContain('<m>');
  });

  it('handles marker in pre-formatted HTML', () => {
    const html = '<font color="#888">Status: <m>Cid</m> is online</font>';
    const result = pillifyMentions(html, cache);
    expect(result).toContain('href="https://matrix.to/#/@cid:a-gis.org"');
  });

  it('escapes special characters in userId for HTML safety', () => {
    const evilCache = makeCache([
      ['@evil"><script>:server', 'Evil'],
    ]);
    const result = pillifyMentions('<m>Evil</m> hi', evilCache);
    expect(result).not.toContain('<script>');
    expect(result).toContain('&gt;');
  });

  it('handles whitespace in marker name', () => {
    const result = pillifyMentions('<m> Cid </m> hello', cache);
    expect(result).toContain('href="https://matrix.to/#/@cid:a-gis.org"');
  });

  it('does not false-match email addresses', () => {
    const result = pillifyMentions('email cid@example.com', cache);
    expect(result).toBe('email cid@example.com');
  });

  it('does not false-match code snippets with @', () => {
    const result = pillifyMentions('<code>@Cid.method()</code>', cache);
    expect(result).toBe('<code>@Cid.method()</code>');
  });
});

// --- convertRawMentions (inbound: @Name → <m>Name</m>) ---

describe('convertRawMentions', () => {
  // Display names match actual format: <pip> <name> <shipEmoji>
  const cache = makeCache([
    ['@cid:a-gis.org', '🟢 Cid 🦁'],
    ['@nora:a-gis.org', '💤 Nora 🪽'],
    ['@norm-bot:a-gis.org', '🟢 Norm 🦁'],
  ]);

  it('converts @Name to <m>Name</m>', () => {
    expect(convertRawMentions('@Cid hello', cache)).toBe('<m>Cid</m> hello');
  });

  it('converts case-insensitively', () => {
    expect(convertRawMentions('@cid hello', cache)).toBe('<m>Cid</m> hello');
    expect(convertRawMentions('@CID hello', cache)).toBe('<m>Cid</m> hello');
  });

  it('converts multiple @Names', () => {
    const result = convertRawMentions('@Cid and @Nora review', cache);
    expect(result).toBe('<m>Cid</m> and <m>Nora</m> review');
  });

  it('does not touch text without @', () => {
    expect(convertRawMentions('hello world', cache)).toBe('hello world');
  });

  it('does not convert unknown @names', () => {
    expect(convertRawMentions('@Unknown hello', cache)).toBe('@Unknown hello');
  });

  it('does not convert email addresses', () => {
    expect(convertRawMentions('email cid@example.com', cache)).toBe('email cid@example.com');
  });

  it('does not double-convert names already in <m> markers', () => {
    expect(convertRawMentions('<m>Cid</m> hello', cache)).toBe('<m>Cid</m> hello');
  });

  it('converts @Name at end of message', () => {
    expect(convertRawMentions('hey @Cid', cache)).toBe('hey <m>Cid</m>');
  });

  it('converts @Name with punctuation after', () => {
    expect(convertRawMentions('@Cid, can you help?', cache)).toBe('<m>Cid</m>, can you help?');
  });

  it('returns text unchanged with empty cache', () => {
    expect(convertRawMentions('@Cid hello', new Map())).toBe('@Cid hello');
  });
});
