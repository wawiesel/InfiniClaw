import { describe, it, expect } from 'vitest';
import { buildRate, buildCumulative, RateTimeline, type Turn } from '../token-rate.js';

describe('buildRate (batch)', () => {
  it('returns empty for no turns', () => {
    expect(buildRate([])).toEqual([]);
  });

  it('single turn — constant rate over interval', () => {
    const rates = buildRate([{ t_start: 0, t_end: 3600_000, tokens: 1000 }]);
    expect(rates).toEqual([
      { t: 0, rate: 1000 },
      { t: 3600_000, rate: 0 },
    ]);
  });

  it('two non-overlapping turns', () => {
    const rates = buildRate([
      { t_start: 0, t_end: 3600_000, tokens: 1000 },
      { t_start: 7200_000, t_end: 10800_000, tokens: 3000 },
    ]);
    expect(rates).toEqual([
      { t: 0, rate: 1000 },
      { t: 3600_000, rate: 0 },
      { t: 7200_000, rate: 3000 },
      { t: 10800_000, rate: 0 },
    ]);
  });

  it('two overlapping turns — rates add', () => {
    const rates = buildRate([
      { t_start: 0, t_end: 7200_000, tokens: 2000 },
      { t_start: 3600_000, t_end: 7200_000, tokens: 500 },
    ]);
    expect(rates).toEqual([
      { t: 0, rate: 1000 },
      { t: 3600_000, rate: 1500 },
      { t: 7200_000, rate: 0 },
    ]);
  });

  it('MB + BB concurrent', () => {
    const mb: Turn = { t_start: 0, t_end: 600_000, tokens: 6000 };
    const bb: Turn = { t_start: 180_000, t_end: 480_000, tokens: 3000 };
    const rates = buildRate([mb, bb]);
    const mbRate = 6000 / (600_000 / 3600_000);
    const bbRate = 3000 / (300_000 / 3600_000);
    expect(rates.length).toBe(4);
    expect(rates[0]).toEqual({ t: 0, rate: mbRate });
    expect(rates[1]).toEqual({ t: 180_000, rate: mbRate + bbRate });
    expect(rates[2]).toEqual({ t: 480_000, rate: mbRate });
    expect(rates[3]).toEqual({ t: 600_000, rate: 0 });
  });

  it('skips zero-duration turns', () => {
    const rates = buildRate([
      { t_start: 1000, t_end: 1000, tokens: 500 },
      { t_start: 0, t_end: 3600_000, tokens: 1000 },
    ]);
    expect(rates).toEqual([
      { t: 0, rate: 1000 },
      { t: 3600_000, rate: 0 },
    ]);
  });
});

describe('buildCumulative', () => {
  it('returns empty for empty rates', () => {
    expect(buildCumulative([])).toEqual([]);
  });

  it('constant rate — linear cumulative', () => {
    const cum = buildCumulative(buildRate([{ t_start: 0, t_end: 3600_000, tokens: 1000 }]));
    expect(cum).toEqual([
      { t: 0, cum: 0 },
      { t: 3600_000, cum: 1000 },
    ]);
  });

  it('cumulative total equals sum of all tokens', () => {
    const turns: Turn[] = [
      { t_start: 0, t_end: 3600_000, tokens: 1000 },
      { t_start: 3600_000, t_end: 7200_000, tokens: 2000 },
      { t_start: 5400_000, t_end: 9000_000, tokens: 500 },
    ];
    const cum = buildCumulative(buildRate(turns));
    expect(cum[cum.length - 1].cum).toBeCloseTo(3500, 0);
  });

  it('cumulative is monotonically increasing', () => {
    const turns: Turn[] = [
      { t_start: 0, t_end: 600_000, tokens: 6000 },
      { t_start: 180_000, t_end: 480_000, tokens: 3000 },
      { t_start: 700_000, t_end: 900_000, tokens: 1000 },
    ];
    const cum = buildCumulative(buildRate(turns));
    for (let i = 1; i < cum.length; i++) {
      expect(cum[i].cum).toBeGreaterThanOrEqual(cum[i - 1].cum);
    }
  });
});

describe('RateTimeline (incremental)', () => {
  it('matches batch buildRate for single turn', () => {
    const tl = new RateTimeline();
    tl.addTurn({ t_start: 0, t_end: 3600_000, tokens: 1000 });
    expect(tl.getRates()).toEqual(buildRate([{ t_start: 0, t_end: 3600_000, tokens: 1000 }]));
  });

  it('matches batch buildRate for overlapping turns', () => {
    const turns: Turn[] = [
      { t_start: 0, t_end: 7200_000, tokens: 2000 },
      { t_start: 3600_000, t_end: 7200_000, tokens: 500 },
    ];
    const tl = new RateTimeline();
    for (const t of turns) tl.addTurn(t);
    expect(tl.getRates()).toEqual(buildRate(turns));
  });

  it('matches batch for MB+BB scenario', () => {
    const turns: Turn[] = [
      { t_start: 0, t_end: 600_000, tokens: 6000 },
      { t_start: 180_000, t_end: 480_000, tokens: 3000 },
    ];
    const tl = new RateTimeline();
    for (const t of turns) tl.addTurn(t);
    expect(tl.getRates()).toEqual(buildRate(turns));
  });

  it('incremental add produces same result regardless of order', () => {
    const turns: Turn[] = [
      { t_start: 0, t_end: 3600_000, tokens: 1000 },
      { t_start: 7200_000, t_end: 10800_000, tokens: 3000 },
      { t_start: 1800_000, t_end: 9000_000, tokens: 500 },
    ];
    const tl1 = new RateTimeline();
    for (const t of turns) tl1.addTurn(t);

    const tl2 = new RateTimeline();
    for (const t of [...turns].reverse()) tl2.addTurn(t);

    expect(tl1.getRates()).toEqual(tl2.getRates());
  });

  it('getRatesWindow returns only points in range', () => {
    const tl = new RateTimeline();
    tl.addTurn({ t_start: 0, t_end: 3600_000, tokens: 1000 });
    tl.addTurn({ t_start: 7200_000, t_end: 10800_000, tokens: 2000 });

    const window = tl.getRatesWindow(3600_000, 10800_000);
    expect(window.length).toBe(2);        // [3600K,0] and [7200K,2000]
    expect(window[0].t).toBe(3600_000);
    expect(window[0].rate).toBe(0);       // gap
    expect(window[1].t).toBe(7200_000);
    expect(window[1].rate).toBe(2000);
  });

  it('getCumulative with since parameter', () => {
    const tl = new RateTimeline();
    tl.addTurn({ t_start: 0, t_end: 3600_000, tokens: 1000 });
    tl.addTurn({ t_start: 7200_000, t_end: 10800_000, tokens: 2000 });

    const cum = tl.getCumulative(3600_000);
    expect(cum[0].cum).toBe(0); // starts at 0 from the since point
  });

  it('handles 1000 turns in under 50ms', () => {
    const tl = new RateTimeline();
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      const t = i * 60_000; // 1 turn per minute
      tl.addTurn({ t_start: t, t_end: t + 30_000, tokens: 100 });
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
    expect(tl.length).toBe(2000); // 1000 starts + 1000 ends
  });

  it('single addTurn on large timeline is fast', () => {
    const tl = new RateTimeline();
    // Build a timeline with 10000 turns
    for (let i = 0; i < 10000; i++) {
      tl.addTurn({ t_start: i * 60_000, t_end: i * 60_000 + 30_000, tokens: 100 });
    }
    // Now add one more — should be fast
    const start = performance.now();
    tl.addTurn({ t_start: 10000 * 60_000, t_end: 10000 * 60_000 + 30_000, tokens: 100 });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1); // sub-millisecond
  });
});
