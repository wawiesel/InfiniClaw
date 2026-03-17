import { describe, it, expect } from 'vitest';
import {
  parseHealthReportTs,
  isHealthReportStale,
  STALE_HEALTH_THRESHOLD_MS,
} from './health-staleness.js';

describe('parseHealthReportTs', () => {
  it('parses a numeric epoch ms value', () => {
    const ts = 1_700_000_000_000;
    expect(parseHealthReportTs({ ts })).toBe(ts);
  });

  it('parses an ISO-8601 string', () => {
    const iso = '2024-01-15T12:00:00.000Z';
    expect(parseHealthReportTs({ ts: iso })).toBe(new Date(iso).getTime());
  });

  it('returns NaN when ts is absent', () => {
    expect(parseHealthReportTs({})).toBeNaN();
  });

  it('returns NaN for an unparseable string', () => {
    expect(parseHealthReportTs({ ts: 'not-a-date' })).toBeNaN();
  });
});

describe('isHealthReportStale', () => {
  const THRESHOLD = STALE_HEALTH_THRESHOLD_MS; // 30 min

  it('returns false for a fresh report (just now)', () => {
    const now = Date.now();
    const data = { ts: new Date(now - 1_000).toISOString() };
    expect(isHealthReportStale(data, THRESHOLD, now)).toBe(false);
  });

  it('returns false for a report exactly at the threshold', () => {
    const now = Date.now();
    const data = { ts: new Date(now - THRESHOLD).toISOString() };
    expect(isHealthReportStale(data, THRESHOLD, now)).toBe(false);
  });

  it('returns true for a report one ms past the threshold', () => {
    const now = Date.now();
    const data = { ts: new Date(now - THRESHOLD - 1).toISOString() };
    expect(isHealthReportStale(data, THRESHOLD, now)).toBe(true);
  });

  it('returns true for a very old report (numeric ts)', () => {
    const now = Date.now();
    const data = { ts: now - 2 * THRESHOLD };
    expect(isHealthReportStale(data, THRESHOLD, now)).toBe(true);
  });

  it('returns false (no alarm) when ts is missing', () => {
    expect(isHealthReportStale({}, THRESHOLD, Date.now())).toBe(false);
  });

  it('returns false (no alarm) when ts is unparseable', () => {
    expect(isHealthReportStale({ ts: 'garbage' }, THRESHOLD, Date.now())).toBe(false);
  });
});
