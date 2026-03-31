/**
 * Token pricing — cost per token by provider/model (R9).
 * Prices in USD per million tokens.
 *
 * Source of truth: S3 at config/token-prices.json
 * loadPricing() fetches from S3 periodically. Falls back to local config/.
 * Historical prices are embedded in each DB row at INSERT time — never changed.
 */
import fs from 'fs';
import path from 'path';
import { resolveRoot } from './service.js';
import { logger } from 'nanoclaw/logger.js';

export interface ModelPricing {
  input: number;       // $/M input tokens
  output: number;      // $/M output tokens
  cache_write: number; // $/M cache write tokens
  cache_read: number;  // $/M cache read tokens
}

const DEFAULT_PRICING: ModelPricing = { input: 3.00, output: 15.00, cache_write: 3.75, cache_read: 0.30 };
const S3_KEY = 'config/token-prices.json';

/** Loaded pricing table. Refreshed by loadPricing(). */
export let MODEL_PRICING: Record<string, ModelPricing> = {};

/** Load pricing from S3, falling back to local config/token-prices.json. */
export async function loadPricing(): Promise<Record<string, ModelPricing>> {
  // Try S3 first (5s timeout to avoid blocking tests/startup)
  try {
    const s3 = await import('./s3-sync.js');
    const client = s3.getClient();
    if (client) {
      const { GetObjectCommand } = await import('@aws-sdk/client-s3');
      const resp = await client.client.send(new GetObjectCommand({ Bucket: client.bucket, Key: S3_KEY }), { abortSignal: AbortSignal.timeout(5000) });
      const content = await resp.Body?.transformToString() ?? '';
      if (content) {
        MODEL_PRICING = JSON.parse(content);
        logger.info({ models: Object.keys(MODEL_PRICING).length }, 'token-pricing: loaded from S3');
        return MODEL_PRICING;
      }
    }
  } catch { /* S3 unavailable or timeout — fall through to local */ }
  // Fall back to local file
  try {
    const f = path.join(resolveRoot(), 'config', 'token-prices.json');
    MODEL_PRICING = JSON.parse(fs.readFileSync(f, 'utf-8'));
    logger.info({ models: Object.keys(MODEL_PRICING).length }, 'token-pricing: loaded from local config');
  } catch { /* keep previous or empty */ }
  return MODEL_PRICING;
}

/** Upload current pricing to S3 (for initial seeding). */
export async function savePricing(): Promise<void> {
  try {
    const s3 = await import('./s3-sync.js');
    await s3.uploadContent(S3_KEY, JSON.stringify(MODEL_PRICING, null, 2));
  } catch (err) {
    logger.warn({ err }, 'token-pricing: failed to save to S3');
  }
}

/** Get pricing for a model key like 'anthropic/claude-sonnet-4-6'. */
export function getPricing(modelKey: string): ModelPricing {
  return MODEL_PRICING[modelKey] || DEFAULT_PRICING;
}

/** Compute cost in USD: sum_k[tokens_k * price_per_token_k] */
export function computeCost(modelKey: string, input: number, output: number, cacheWrite: number, cacheRead: number): number {
  const p = getPricing(modelKey);
  return (input * p.input + output * p.output + cacheWrite * p.cache_write + cacheRead * p.cache_read) / 1_000_000;
}
