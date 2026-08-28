'use client';

/**
 * A strategist that answers instantly and costs nothing.
 *
 * Every AI state of the recommendation card - thinking, confirming, overriding,
 * failing - needs to be LOOKED at, and the real strategist costs about twenty
 * cents an answer and twenty seconds of waiting. So the states can be summoned
 * with `?ai=confirmed`, `?ai=override`, `?ai=analyzing` or `?ai=fallback`.
 *
 * It is a transport, not a mock of the card: the fake response goes through the
 * real validator, the real guardrails and the real staleness gate, so what
 * appears on screen is produced by exactly the code a live answer would go
 * through.
 *
 * Reachable only where diagnostics are - development, or an explicit
 * `?diagnostics=1`. It can never be the strategist in production.
 */
import type {
  StrategistTransport,
  StrategistTransportResult,
} from '@/packages/engine/strategist/live';
import type { StrategistResponse } from '@/packages/engine/strategist/anthropic/schema';

export type FakeStrategistMode = 'confirmed' | 'override' | 'analyzing' | 'fallback';

export function parseFakeStrategist(search: string): FakeStrategistMode | null {
  const value = new URLSearchParams(search).get('ai');
  return value === 'confirmed' ||
    value === 'override' ||
    value === 'analyzing' ||
    value === 'fallback'
    ? value
    : null;
}

/** Long enough to see the "analyzing" state, short enough to be usable. */
const LATENCY_MS = 1200;

export class FakeStrategistTransport implements StrategistTransport {
  constructor(private readonly mode: FakeStrategistMode) {}

  async advise(
    input: Parameters<StrategistTransport['advise']>[0],
  ): Promise<StrategistTransportResult> {
    const delay = this.mode === 'analyzing' ? 3_600_000 : LATENCY_MS;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delay);
      input.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      });
    });

    const base = {
      state: input.state,
      model: 'fake-strategist',
      usage: {
        inputTokens: 14_400,
        cacheWriteTokens: 0,
        cacheReadTokens: 13_900,
        outputTokens: 520,
      },
      attempts: 1,
      latencyMs: delay,
    };

    if (this.mode === 'fallback') {
      return { ...base, response: null, problems: [], error: 'The strategist is unavailable.' };
    }

    /*
     * The board arrives in the strategist's own order, so "the engine's pick"
     * is the first id and an override is simply a different one.
     */
    const [first, second, third] = input.boardPlayerIds;
    const chosen = this.mode === 'override' ? (second ?? first) : first;
    const alternatives = [first, second, third].filter((id) => id && id !== chosen).slice(0, 2);

    return { ...base, response: fakeResponse(chosen, alternatives), problems: [], error: null };
  }
}

function fakeResponse(chosen: string, alternatives: string[]): StrategistResponse {
  return {
    recommendedPlayerId: chosen,
    alternatives: [
      { playerId: alternatives[0] ?? chosen, reason: 'The next best fit for the same slot.' },
      { playerId: alternatives[1] ?? chosen, reason: 'Cheaper, and the tier behind him is deep.' },
    ],
    confidence: 78,
    urgency: 'must_take_now',
    strategy: 'Fill the starting slot now and let the deeper position wait a round.',
    reasons: [
      { code: 'starter_need', detail: 'The slot is empty and nothing else on the board fills it.' },
      { code: 'tier_cliff', detail: 'Two players remain in the tier and three teams pick before you.' },
      { code: 'opportunity_cost', detail: 'Waiting costs more than the alternative gains.' },
    ],
    strongestAlternativePlayerId: alternatives[0] ?? chosen,
    strongestAlternativeWhy: 'He projects within a few points and survives more often.',
    strongestCounterargument:
      'He is 77% to survive to your next selection, so the tier is not actually forcing this pick.',
    whyRecommendationStillWins:
      'Seventy-seven per cent is the marginal number; the pair figure says both survive only 61% of the time, and losing this slot has no replacement.',
    firstSeedDeviationReason: null,
    expectedNextPickPlan: 'Take the best receiver still on the board at your next selection.',
    opponentsThatMatter: [{ rosterId: 1, why: 'Two empty starting slots at the same position.' }],
  };
}
