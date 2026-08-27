/**
 * Server-only. Importing anything here pulls in the Anthropic SDK and reads
 * `ANTHROPIC_API_KEY`, so it must never reach a browser bundle.
 */
export {
  AnthropicStrategist,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STRATEGIST_MODEL,
  resolveStrategistModel,
  resolveThinkingBudget,
  strategistFingerprint,
  toAdvice,
} from './client';
export type { AnthropicStrategistOptions, StrategistCallResult } from './client';
export { PLAYBOOK_VERSION, STRATEGIST_SYSTEM_PROMPT } from './playbook';
export { SUBMIT_RECOMMENDATION_TOOL } from './schema';
export type { StrategistResponse } from './schema';
export { CACHE_DIRECTORY, cacheKey, listCached, readCached, writeCached } from './cache';
export type { CachedCall } from './cache';
