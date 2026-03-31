import { describe, it, expect, beforeEach } from 'vitest';
import { getPricing, computeCost, loadPricing, MODEL_PRICING, type ModelPricing } from '../token-pricing.js';
import fs from 'fs';
import path from 'path';
import { resolveRoot } from '../service.js';

describe('token-pricing', () => {
  beforeEach(async () => {
    // Ensure pricing is loaded from local config
    await loadPricing();
  });

  describe('loadPricing', () => {
    it('loads pricing from config/token-prices.json', async () => {
      const pricing = await loadPricing();
      expect(Object.keys(pricing).length).toBeGreaterThan(0);
    });

    it('config file has separate cache_write and cache_read', async () => {
      const f = path.join(resolveRoot(), 'config', 'token-prices.json');
      const data = JSON.parse(fs.readFileSync(f, 'utf-8'));
      for (const [model, p] of Object.entries(data) as [string, ModelPricing][]) {
        expect(p).toHaveProperty('input');
        expect(p).toHaveProperty('output');
        expect(p).toHaveProperty('cache_write');
        expect(p).toHaveProperty('cache_read');
      }
    });

    it('opus cache_write > cache_read', () => {
      const opus = MODEL_PRICING['anthropic/claude-opus-4-6'];
      expect(opus).toBeDefined();
      expect(opus.cache_write).toBeGreaterThan(opus.cache_read);
    });
  });

  describe('getPricing', () => {
    it('returns known model pricing', () => {
      const p = getPricing('anthropic/claude-opus-4-6');
      expect(p.input).toBe(15.00);
      expect(p.output).toBe(75.00);
      expect(p.cache_write).toBe(18.75);
      expect(p.cache_read).toBe(1.50);
    });

    it('returns default for unknown model', () => {
      const p = getPricing('unknown/model');
      expect(p.input).toBeGreaterThan(0);
      expect(p.output).toBeGreaterThan(0);
    });

    it('ollama models are zero cost', () => {
      const p = getPricing('ollama/qwen3:14b');
      expect(p.input).toBe(0);
      expect(p.output).toBe(0);
      expect(p.cache_write).toBe(0);
      expect(p.cache_read).toBe(0);
    });
  });

  describe('computeCost', () => {
    // cost = sum_k[tokens_k * price_per_token_k] where price is $/M tokens
    it('opus: 1000 input + 1000 output + 1000 cw + 1000 cr', () => {
      const cost = computeCost('anthropic/claude-opus-4-6', 1000, 1000, 1000, 1000);
      // (1000*15 + 1000*75 + 1000*18.75 + 1000*1.50) / 1M = 0.11025
      expect(cost).toBeCloseTo(0.11025, 5);
    });

    it('sonnet: 500 input + 3000 output + 5000 cw + 40000 cr', () => {
      const cost = computeCost('anthropic/claude-sonnet-4-6', 500, 3000, 5000, 40000);
      // (500*3 + 3000*15 + 5000*3.75 + 40000*0.30) / 1M
      // = (1500 + 45000 + 18750 + 12000) / 1M = 77250/1M = 0.07725
      expect(cost).toBeCloseTo(0.07725, 5);
    });

    it('zero tokens = zero cost', () => {
      expect(computeCost('anthropic/claude-opus-4-6', 0, 0, 0, 0)).toBe(0);
    });

    it('ollama = zero cost regardless of tokens', () => {
      expect(computeCost('ollama/qwen3:14b', 10000, 10000, 10000, 10000)).toBe(0);
    });

    it('cost scales linearly with tokens', () => {
      const c1 = computeCost('anthropic/claude-sonnet-4-6', 100, 100, 100, 100);
      const c10 = computeCost('anthropic/claude-sonnet-4-6', 1000, 1000, 1000, 1000);
      expect(c10).toBeCloseTo(c1 * 10, 10);
    });
  });
});
