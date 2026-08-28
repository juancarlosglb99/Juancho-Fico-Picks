/**
 * One card, five states, and the rule that the deterministic answer is always
 * on it. Every assertion below is really the same assertion: whatever the
 * strategist does, a player and a reason are on screen.
 */
import { describe, expect, it } from 'vitest';
import { resolveStrategistDecision } from '../../packages/engine/strategist/audit';
import type { LiveStrategistState } from '../../packages/engine/strategist/live';
import type { StrategistAdvice } from '../../packages/engine/strategist/types';
import { resolveRecommendationCard } from '../../packages/ui/recommendation';
import { scenario } from './scenario';

const state = scenario({ picksMade: 26 });
const { result, brief } = state;
const internals = result.internals!;

const nameOf = (playerId: string) => {
  const player = internals.playerOf(playerId);
  return player ? { name: player.name, position: player.position } : null;
};
const survivalOf = (playerId: string) => internals.survivalOf(playerId).value;

function advise(playerId: string, overrides: Partial<StrategistAdvice> = {}): StrategistAdvice {
  return {
    state: brief.state,
    primary: {
      playerId,
      reasoning: 'starter_need: fills the empty flex.',
      reasonCodes: ['starter_need'],
      confidence: 0.82,
    },
    alternatives: [
      { playerId: alternativeId(playerId), reasoning: 'Next best.', reasonCodes: [], confidence: 0 },
    ],
    roomRead: null,
    confidence: 0.82,
    urgency: 'must_take_now',
    strategy: 'Fill the flex before the tier empties.',
    reasons: [
      { code: 'starter_need', detail: 'The flex slot is empty.' },
      { code: 'tier_cliff', detail: 'Two players left in the tier.' },
      { code: 'opponent_demand', detail: 'Three teams ahead need the position.' },
      { code: 'ignored', detail: 'A fourth reason the card must not show.' },
    ],
    strongestCounterargument: 'He is 78% to survive to your next selection.',
    whyRecommendationStillWins: 'The tier behind him is empty, so 78% is not the question.',
    expectedNextPickPlan: 'Take a receiver at 46.',
    ...overrides,
  };
}

function alternativeId(playerId: string): string {
  const other = result.recommendations.find(
    (recommendation) => recommendation.player.id !== playerId,
  );
  return other!.player.id;
}

function liveState(
  phase: LiveStrategistState['phase'],
  advice: StrategistAdvice | null,
  overrides: Partial<LiveStrategistState> = {},
): LiveStrategistState {
  const decision = advice === null ? null : resolveStrategistDecision({ brief, advice });
  return {
    phase,
    fingerprint: brief.state.boardFingerprint,
    decision,
    reason: null,
    usage: null,
    ...overrides,
  };
}

function card(strategist: LiveStrategistState | null, fingerprint = brief.state.boardFingerprint) {
  return resolveRecommendationCard({
    result,
    strategist,
    currentFingerprint: fingerprint,
    nameOf,
    survivalOf,
  });
}

describe('the single recommendation card', () => {
  it('shows the engine pick immediately, with no strategist at all', () => {
    const model = card(null);
    expect(model.state).toBe('engine');
    expect(model.source).toBe('engine');
    expect(model.primary?.playerId).toBe(result.recommendations[0].player.id);
    expect(model.urgency?.source).toBe('engine');
    expect(model.reasons.length).toBeGreaterThan(0);
    expect(model.reasons.length).toBeLessThanOrEqual(2);
    expect(model.evidence.length).toBeGreaterThan(0);
    expect(model.alternatives).toHaveLength(2);
  });

  it('keeps the whole engine answer visible while the strategist thinks', () => {
    const model = card(liveState('analyzing', null));
    expect(model.state).toBe('engine_ai_running');
    // The card is NOT replaced by a spinner: the player, the reasons and the
    // evidence are all still on it.
    expect(model.primary?.playerId).toBe(result.recommendations[0].player.id);
    expect(model.reasons.length).toBeGreaterThan(0);
    expect(model.evidence.length).toBeGreaterThan(0);
  });

  it('confirms rather than duplicates when the strategist agrees', () => {
    const enginePick = result.recommendations[0].player.id;
    const model = card(liveState('ready', advise(enginePick)));
    expect(model.state).toBe('ai_confirmed');
    expect(model.source).toBe('ai');
    expect(model.primary?.playerId).toBe(enginePick);
    // Nothing to compare against: there is only one pick on the card.
    expect(model.enginePick).toBeNull();
    expect(model.aiConfidence).toBe(82);
    expect(model.urgency).toEqual({ label: 'Take him now', tone: 'now', source: 'ai' });
    expect(model.reasons).toHaveLength(3);
    expect(model.reasons.map((reason) => reason.code)).not.toContain('ignored');
    expect(model.counterargument?.objection).toContain('78%');
    expect(model.counterargument?.answer).toContain('tier behind him');
  });

  it('promotes the strategist pick on an override and demotes the engine to one line', () => {
    const aiPick = result.recommendations[2].player.id;
    const model = card(liveState('ready', advise(aiPick)));
    expect(model.state).toBe('ai_override');
    expect(model.primary?.playerId).toBe(aiPick);
    expect(model.enginePick).toEqual({
      playerId: result.recommendations[0].player.id,
      name: result.recommendations[0].player.name,
    });
    // The evidence follows the player on the card, not the player it replaced.
    expect(model.evidence.length).toBeGreaterThan(0);
    expect(model.alternatives[0].name).not.toBe(model.alternatives[0].playerId);
  });

  it('falls back quietly - never an error - when the strategist is rejected', () => {
    // A player who is already drafted: the guardrails must refuse him.
    const gone = state.players.bySleeperId.get(state.picks[0].player_id)!.id;
    const model = card(liveState('ready', advise(gone)));
    expect(model.state).toBe('engine_ai_unavailable');
    expect(model.source).toBe('engine');
    expect(model.primary?.playerId).toBe(result.recommendations[0].player.id);
    expect(model.note).toBeTruthy();
  });

  it('carries a fallback reason through without dressing it up', () => {
    const model = card(
      liveState('fallback', null, { reason: 'The strategist is unavailable.' }),
    );
    expect(model.state).toBe('engine_ai_unavailable');
    expect(model.note).toBe('The strategist is unavailable.');
    expect(model.primary?.playerId).toBe(result.recommendations[0].player.id);
  });

  it('refuses advice about a board that has already moved', () => {
    const aiPick = result.recommendations[2].player.id;
    const stale = liveState('ready', advise(aiPick));
    // The subscription still holds the previous board; the screen has a newer one.
    const model = card(stale, 'a-newer-board-fingerprint');
    expect(model.state).toBe('engine_ai_unavailable');
    expect(model.primary?.playerId).toBe(result.recommendations[0].player.id);
    expect(model.note).toContain('board moved');
  });

  it('reports nothing to recommend rather than inventing a player', () => {
    const empty = resolveRecommendationCard({
      result: { ...result, recommendations: [] },
      strategist: null,
      currentFingerprint: brief.state.boardFingerprint,
      nameOf,
      survivalOf,
    });
    expect(empty.state).toBe('unavailable');
    expect(empty.primary).toBeNull();
  });

  it('describes a strategist pick the engine never shortlisted', () => {
    const outsider = brief.candidates.find(
      (candidate) =>
        !result.recommendations.some(
          (recommendation) => recommendation.player.id === candidate.playerId,
        ),
    );
    if (!outsider) return;
    const model = card(liveState('ready', advise(outsider.playerId)));
    expect(model.state).toBe('ai_override');
    expect(model.primary?.playerId).toBe(outsider.playerId);
    expect(model.primary?.name).toBe(outsider.name);
  });
});

/** The state a `null` brief produces, which is a live possibility. */
describe('the card without a brief', () => {
  it('is still the engine card', () => {
    const model = resolveRecommendationCard({
      result,
      strategist: null,
      currentFingerprint: null,
      nameOf,
      survivalOf,
    });
    expect(model.state).toBe('engine');
    expect(model.primary).not.toBeNull();
  });
});
