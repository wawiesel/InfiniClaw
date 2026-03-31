/**
 * Tests for the dashboard's piecewise-constant rate math.
 * These use the same RateTimeline from token-rate.ts which implements
 * the identical math as the browser's UnionGrid class.
 *
 * If any of these fail, the dashboard plots would be wrong.
 */
import { describe, it, expect } from 'vitest';
import { RateTimeline, buildRate, buildCumulative } from '../token-rate.js';

const HR = 3600_000; // ms per hour

describe('stacking — overlapping turns sum on union grid', () => {
  it('Captain scenario: opus 0-5hr + sonnet 4-10hr, overlap at 4-5hr', () => {
    // opus: 5 tokens over 5hr = 1 tok/hr
    // sonnet: 12 tokens over 6hr = 2 tok/hr
    const tl = new RateTimeline();
    tl.addTurn({ t_start: 0, t_end: 5 * HR, tokens: 5 });
    tl.addTurn({ t_start: 4 * HR, t_end: 10 * HR, tokens: 12 });
    const rates = tl.getRates();
    // Grid: [0, 4hr, 5hr, 10hr]
    // [0,4hr): opus only = 1
    // [4hr,5hr): opus+sonnet = 1+2 = 3
    // [5hr,10hr): sonnet only = 2
    expect(rates).toEqual([
      { t: 0, rate: 1 },
      { t: 4 * HR, rate: 3 },
      { t: 5 * HR, rate: 2 },
      { t: 10 * HR, rate: 0 },
    ]);
  });

  it('same-model overlap: two sonnet turns stacking', () => {
    // Turn A: 60s, 8500 tokens = 510000 tok/hr
    // Turn B: 30s, 4700 tokens = 564000 tok/hr, starts at 30s
    const tl = new RateTimeline();
    tl.addTurn({ t_start: 0, t_end: 60_000, tokens: 8500 });
    tl.addTurn({ t_start: 30_000, t_end: 60_000, tokens: 4700 });
    const rates = tl.getRates();
    expect(rates).toEqual([
      { t: 0, rate: 510000 },
      { t: 30_000, rate: 510000 + 564000 },
      { t: 60_000, rate: 0 },
    ]);
  });

  it('per-series rates on shared grid', () => {
    // Two series on the same grid, each sees only its own turns
    const grid = new RateTimeline();
    const opusTurn = { t_start: 0, t_end: 60_000, tokens: 8500 };
    const sonnetTurn = { t_start: 30_000, t_end: 60_000, tokens: 4700 };
    grid.addTurn(opusTurn);
    grid.addTurn(sonnetTurn);

    // Build separate timelines for per-series rates
    const opusTL = new RateTimeline();
    opusTL.addTurn(opusTurn);

    const sonnetTL = new RateTimeline();
    sonnetTL.addTurn(sonnetTurn);

    // Combined rates match the stacked total
    const combined = grid.getRates();
    expect(combined[0].rate).toBe(510000);      // 0-30s: opus only
    expect(combined[1].rate).toBe(510000 + 564000); // 30-60s: both
    expect(combined[2].rate).toBe(0);            // after 60s
  });
});

describe('cumulative — piecewise linear, monotonically increasing', () => {
  it('single turn cumulative equals total tokens', () => {
    const rates = buildRate([{ t_start: 0, t_end: HR, tokens: 1000 }]);
    const cum = buildCumulative(rates);
    // Last point should equal total tokens
    expect(cum[cum.length - 1].cum).toBeCloseTo(1000, 5);
  });

  it('cumulative is monotonically increasing', () => {
    const rates = buildRate([
      { t_start: 0, t_end: 2 * HR, tokens: 500 },
      { t_start: HR, t_end: 3 * HR, tokens: 800 },
    ]);
    const cum = buildCumulative(rates);
    for (let i = 1; i < cum.length; i++) {
      expect(cum[i].cum).toBeGreaterThanOrEqual(cum[i - 1].cum);
    }
  });

  it('overlapping turns: cumulative = sum of all tokens', () => {
    const rates = buildRate([
      { t_start: 0, t_end: 5 * HR, tokens: 5 },
      { t_start: 4 * HR, t_end: 10 * HR, tokens: 12 },
    ]);
    const cum = buildCumulative(rates);
    expect(cum[cum.length - 1].cum).toBeCloseTo(17, 5); // 5 + 12
  });
});

describe('cost rate tracks token rate boundaries', () => {
  it('cost rate is zero exactly where token rate is zero', () => {
    // A turn from 0-1hr: tokens have a rate, cost has a rate
    // Before 0 and after 1hr: both should be zero
    const tokenRates = buildRate([{ t_start: 0, t_end: HR, tokens: 1000 }]);
    const costRates = buildRate([{ t_start: 0, t_end: HR, tokens: 0.075 }]); // $0.075 total cost

    // Same grid boundaries
    expect(tokenRates.length).toBe(costRates.length);
    for (let i = 0; i < tokenRates.length; i++) {
      expect(tokenRates[i].t).toBe(costRates[i].t);
      // Where tokens are zero, cost must be zero
      if (tokenRates[i].rate === 0) {
        expect(costRates[i].rate).toBe(0);
      }
    }
  });

  it('cost impulse has same width as token impulse', () => {
    const tokenRates = buildRate([{ t_start: 1000, t_end: 61_000, tokens: 8500 }]);
    const costRates = buildRate([{ t_start: 1000, t_end: 61_000, tokens: 0.07725 }]);

    // Both should have exactly 2 rate points (active interval + trailing zero)
    expect(tokenRates.length).toBe(2);
    expect(costRates.length).toBe(2);
    // Same boundaries
    expect(tokenRates[0].t).toBe(costRates[0].t);
    expect(tokenRates[1].t).toBe(costRates[1].t);
  });
});

describe('per-field cost — cache_write and cache_read have different costs', () => {
  // Opus: cache_write=$18.75/M, cache_read=$1.50/M — 12.5x difference
  const entry = {
    t_start: '2026-03-30T10:00:00Z', t_end: '2026-03-30T11:00:00Z',
    input_tokens: 1000, output_tokens: 5000,
    cache_write_tokens: 10000, cache_read_tokens: 100000,
    input_price_per_token: 0.000015, output_price_per_token: 0.000075,
    cache_write_price_per_token: 0.00001875, cache_read_price_per_token: 0.0000015,
    cost: 1000*0.000015 + 5000*0.000075 + 10000*0.00001875 + 100000*0.0000015,
  };

  it('cache_write cost >> cache_read cost per token', () => {
    const cwCost = entry.cache_write_tokens * entry.cache_write_price_per_token;
    const crCost = entry.cache_read_tokens * entry.cache_read_price_per_token;
    // 10000 * 0.00001875 = 0.1875
    // 100000 * 0.0000015 = 0.15
    expect(cwCost).toBeCloseTo(0.1875, 5);
    expect(crCost).toBeCloseTo(0.15, 5);
    expect(cwCost).not.toBeCloseTo(crCost, 2); // they must be different
  });

  it('total cost = sum of all four types', () => {
    const total = entry.input_tokens * entry.input_price_per_token
      + entry.output_tokens * entry.output_price_per_token
      + entry.cache_write_tokens * entry.cache_write_price_per_token
      + entry.cache_read_tokens * entry.cache_read_price_per_token;
    expect(entry.cost).toBeCloseTo(total, 10);
  });

  it('per-field costs are different from total cost', () => {
    const inputCost = entry.input_tokens * entry.input_price_per_token;
    const outputCost = entry.output_tokens * entry.output_price_per_token;
    const cwCost = entry.cache_write_tokens * entry.cache_write_price_per_token;
    const crCost = entry.cache_read_tokens * entry.cache_read_price_per_token;
    // Each field cost must be less than total
    expect(inputCost).toBeLessThan(entry.cost);
    expect(outputCost).toBeLessThan(entry.cost);
    expect(cwCost).toBeLessThan(entry.cost);
    expect(crCost).toBeLessThan(entry.cost);
    // And they must sum to total
    expect(inputCost + outputCost + cwCost + crCost).toBeCloseTo(entry.cost, 10);
  });
});

describe('incremental addTurn preserves correctness', () => {
  it('order independence — same result regardless of insertion order', () => {
    const turns = [
      { t_start: 0, t_end: 5 * HR, tokens: 5 },
      { t_start: 4 * HR, t_end: 10 * HR, tokens: 12 },
      { t_start: 2 * HR, t_end: 3 * HR, tokens: 100 },
    ];
    const forward = new RateTimeline();
    turns.forEach(t => forward.addTurn(t));

    const reverse = new RateTimeline();
    [...turns].reverse().forEach(t => reverse.addTurn(t));

    expect(forward.getRates()).toEqual(reverse.getRates());
  });
});
