/**
 * What a call actually cost, with cached tokens priced as cached tokens.
 *
 * A single "input tokens" figure misreports the bill in both directions once
 * caching is on: a cache write bills above the base rate and a cache read at
 * roughly a tenth of it. Reporting one number would have made the caching
 * change look like a small regression on the write call and a miracle on the
 * reads, and neither would be true.
 *
 * Rates are per million tokens and are stated here rather than assumed, because
 * they change and a benchmark that quietly uses last quarter's prices is worse
 * than one that shows its working.
 */
export interface ModelRate {
  input: number;
  output: number;
  /** Multipliers on the input rate, per Anthropic's published pricing. */
  cacheWriteMultiplier: number;
  cacheReadMultiplier: number;
}

export const MODEL_RATES: Record<string, ModelRate> = {
  opus: { input: 15, output: 75, cacheWriteMultiplier: 1.25, cacheReadMultiplier: 0.1 },
  sonnet: { input: 3, output: 15, cacheWriteMultiplier: 1.25, cacheReadMultiplier: 0.1 },
  haiku: { input: 1, output: 5, cacheWriteMultiplier: 1.25, cacheReadMultiplier: 0.1 },
};

export function rateFor(model: string): ModelRate {
  if (model.includes('opus')) return MODEL_RATES.opus;
  if (model.includes('sonnet')) return MODEL_RATES.sonnet;
  if (model.includes('haiku')) return MODEL_RATES.haiku;
  return MODEL_RATES.opus;
}

export function estimateCost(
  model: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens?: number;
    cacheReadTokens?: number;
  },
): number {
  const rate = rateFor(model);
  return (
    (usage.inputTokens * rate.input +
      (usage.cacheWriteTokens ?? 0) * rate.input * rate.cacheWriteMultiplier +
      (usage.cacheReadTokens ?? 0) * rate.input * rate.cacheReadMultiplier +
      usage.outputTokens * rate.output) /
    1e6
  );
}
