/**
 * Token pricing — cost per token by provider/model.
 * Prices in USD per million tokens. Updated manually.
 * Source: provider pricing pages as of 2026-03.
 */

export interface ModelPricing {
  input: number;   // $/M input tokens
  output: number;  // $/M output tokens
  cache: number;   // $/M cache tokens (creation + read avg)
}

/** Pricing table: provider/model → cost per million tokens. */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Anthropic — https://docs.anthropic.com/en/docs/about-claude/models
  'anthropic/claude-opus-4-6':     { input: 15.00, output: 75.00, cache: 1.875 },
  'anthropic/claude-sonnet-4-6':   { input: 3.00,  output: 15.00, cache: 0.375 },
  'anthropic/claude-haiku-4-5':    { input: 0.80,  output: 4.00,  cache: 0.08 },
  // Ollama — local, zero cost
  'ollama/qwen3:14b':             { input: 0, output: 0, cache: 0 },
  'ollama/qwen3:30b':             { input: 0, output: 0, cache: 0 },
  'ollama/parker-qwen30b':        { input: 0, output: 0, cache: 0 },
};

/** Default pricing for unknown models (assume Sonnet-tier). */
const DEFAULT_PRICING: ModelPricing = { input: 3.00, output: 15.00, cache: 0.375 };

/** Get pricing for a model key like 'anthropic/claude-sonnet-4-6'. */
export function getPricing(modelKey: string): ModelPricing {
  return MODEL_PRICING[modelKey] || DEFAULT_PRICING;
}

/** Compute cost in USD for a token usage entry. */
export function computeCost(modelKey: string, input: number, output: number, cache: number): number {
  const p = getPricing(modelKey);
  return (input * p.input + output * p.output + cache * p.cache) / 1_000_000;
}
