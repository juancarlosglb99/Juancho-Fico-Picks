/**
 * ONE recommendation, whoever produced it.
 *
 * The old screen showed two cards - the deterministic engine's, and the AI's
 * above it - which asks the drafter to arbitrate between his own tools with
 * forty seconds on the clock. There is one card here, and it has one primary
 * player at any moment. The strategist does not get a card of its own; it
 * upgrades this one, or it does not, and either way the deterministic answer
 * was on screen from the first frame.
 *
 * The rules that produce the states:
 *
 *   - the deterministic pick renders IMMEDIATELY and is never replaced by a
 *     spinner. `engine_ai_running` still carries the whole engine answer.
 *   - AI advice is applied only when it describes the board on screen RIGHT
 *     NOW. The live strategist already discards stale replies; this checks the
 *     fingerprint a second time, because React can render a new brief before
 *     the subscription has been told about it.
 *   - once the AI answer is accepted the two are not shown as equals. A
 *     confirmed pick is one player with a tick; an override is the AI's player,
 *     with the engine's demoted to a single line and a way to compare them.
 *   - anything else - malformed, rejected, timed out, unconfigured - is a quiet
 *     note under an unchanged recommendation. None of it is an error state.
 */
import type { StrategistDecision } from '../engine/strategist/audit';
import type { LiveStrategistState, UsageRecord } from '../engine/strategist/live';
import type { StrategistAdvice } from '../engine/strategist/types';
import type {
  DraftRecommendation,
  DraftRecommendationResult,
} from '../engine/draft/types';
import type { Confidence } from '../engine/context/types';
import type { Position } from '../players/types';
import { describeAvailability } from './plain-language';
import { plainVerdict, type PlainVerdict } from './plain-verdict';

export type { PlainVerdict } from './plain-verdict';

export type RecommendationCardState =
  | 'unavailable'
  | 'engine'
  | 'engine_ai_running'
  | 'ai_confirmed'
  | 'ai_override'
  | 'engine_ai_unavailable';

export type UrgencyTone = 'now' | 'soon' | 'calm';

export interface CardPlayer {
  playerId: string;
  name: string;
  position: Position;
  team: string | null;
  tier: number;
  playersRemainingInTier: number;
  /** Juancho's 0-100 draft score. Absent for a player it did not shortlist. */
  score: number | null;
  survival: number | null;
  survivalConfidence: Confidence;
  firstSeedRank: number | null;
}

export interface CardEvidence {
  label: string;
  value: string;
  /** A short explanation, shown on hover or under the value on a phone. */
  detail: string;
}

export interface CardAlternative {
  playerId: string;
  name: string;
  position: Position | null;
  reason: string | null;
  survival: number | null;
}

export interface RecommendationCard {
  state: RecommendationCardState;
  /** The plain-English answer. This is what the card leads with. */
  plain: PlainVerdict | null;
  /** Null only in `unavailable`, when the engine produced nothing to show. */
  primary: CardPlayer | null;
  /** Which layer chose the primary player. */
  source: 'engine' | 'ai';
  urgency: { label: string; tone: UrgencyTone; source: 'engine' | 'ai' } | null;
  /** At most two for the engine, three for the strategist. */
  reasons: { code: string | null; text: string }[];
  evidence: CardEvidence[];
  alternatives: CardAlternative[];
  /** Set only on an override: the pick the engine would have made. */
  enginePick: { playerId: string; name: string } | null;
  /** 0-100, only ever the strategist's. The engine reports a score, not this. */
  aiConfidence: number | null;
  counterargument: { objection: string; answer: string | null } | null;
  strategy: string | null;
  expectedNextPickPlan: string | null;
  /** One muted sentence when the strategist did not contribute. */
  note: string | null;
  usage: UsageRecord | null;
  /** Everything else, for the drawer and the diagnostics view. */
  engineRecommendation: DraftRecommendation | null;
  advice: StrategistAdvice | null;
  decision: StrategistDecision | null;
}

export function resolveRecommendationCard({
  result,
  strategist,
  currentFingerprint,
  nameOf,
  survivalOf,
  tierGapOf,
  tierSurvivesOf,
}: {
  result: DraftRecommendationResult | null;
  strategist: LiveStrategistState | null;
  /** The board on screen. AI advice about any other board is ignored. */
  currentFingerprint: string | null;
  /** Resolves a player id to a display name and position, for alternatives. */
  nameOf: (playerId: string) => { name: string; position: Position | null } | null;
  survivalOf: (playerId: string) => number | null;
  /**
   * Projected points between this player's quality group and the next one.
   *
   * The card never says "tier"; it says whether the board falls away after him,
   * and this is the number that decides which.
   */
  tierGapOf?: (playerId: string) => number | null;
  /** Chance somebody of the same quality is still available at our next turn. */
  tierSurvivesOf?: (playerId: string) => number | null;
}): RecommendationCard {
  const engine = result?.recommendations[0] ?? null;
  const usage = strategist?.usage ?? null;

  if (!engine || !result) {
    return {
      state: 'unavailable',
      plain: null,
      primary: null,
      source: 'engine',
      urgency: null,
      reasons: [],
      evidence: [],
      alternatives: [],
      enginePick: null,
      aiConfidence: null,
      counterargument: null,
      strategy: null,
      expectedNextPickPlan: null,
      note: null,
      usage,
      engineRecommendation: null,
      advice: null,
      decision: null,
    };
  }

  const base = engineCard(result, engine, usage, tierGapOf, tierSurvivesOf);

  if (!strategist || strategist.phase === 'idle') return base;

  if (strategist.phase === 'analyzing') {
    return { ...base, state: 'engine_ai_running' };
  }

  /*
   * A reply is only ever applied to the board it was about. `LiveStrategist`
   * enforces this too; the check is repeated because a render can happen
   * between a new brief arriving and the strategist being told about it, and
   * the cost of the mistake is advice about players who are already gone.
   */
  const fresh =
    currentFingerprint === null || strategist.fingerprint === currentFingerprint;

  const decision = strategist.decision;
  const advice = decision?.audit.advice ?? null;
  const applied = fresh && decision?.final?.source === 'strategist' && advice !== null;

  if (!applied) {
    return {
      ...base,
      state: 'engine_ai_unavailable',
      note: fresh
        ? (strategist.reason ?? 'Showing the deterministic recommendation.')
        : 'The board moved while the strategist was answering.',
      decision: decision ?? null,
    };
  }

  return aiCard({ base, result, decision, advice, nameOf, survivalOf });
}

function engineCard(
  result: DraftRecommendationResult,
  engine: DraftRecommendation,
  usage: UsageRecord | null,
  tierGapOf?: (playerId: string) => number | null,
  tierSurvivesOf?: (playerId: string) => number | null,
): RecommendationCard {
  const alternatives = result.recommendations.slice(1, 3).map((alternative) => ({
    playerId: alternative.player.id,
    name: alternative.player.name,
    position: alternative.player.position,
    reason: alternative.reasons[0] ?? null,
    survival: alternative.availableNextPickProbability,
  }));

  return {
    state: 'engine',
    plain: plainVerdict({
      name: engine.player.name,
      engine,
      picksUntilTurn: result.picksUntilNextUserPick,
      alternative: result.recommendations[1] ?? null,
      tierGap: tierGapOf?.(engine.player.id) ?? null,
      tierSurvives: tierSurvivesOf?.(engine.player.id) ?? null,
    }),
    primary: toCardPlayer(engine),
    source: 'engine',
    urgency: engineUrgency(engine),
    // Two, not four. The rest are in the drawer; this is the line a drafter
    // reads while the clock runs.
    reasons: engine.reasons.slice(0, 2).map((text) => ({ code: null, text })),
    evidence: engineEvidence(engine, result),
    alternatives,
    enginePick: null,
    aiConfidence: null,
    counterargument: null,
    strategy: null,
    expectedNextPickPlan: null,
    note: null,
    usage,
    engineRecommendation: engine,
    advice: null,
    decision: null,
  };
}

function aiCard({
  base,
  result,
  decision,
  advice,
  nameOf,
  survivalOf,
}: {
  base: RecommendationCard;
  result: DraftRecommendationResult;
  decision: StrategistDecision;
  advice: StrategistAdvice;
  nameOf: (playerId: string) => { name: string; position: Position | null } | null;
  survivalOf: (playerId: string) => number | null;
}): RecommendationCard {
  const chosenId = decision.final?.playerId ?? advice.primary.playerId;
  const engine = base.engineRecommendation;
  const confirmed = engine !== null && chosenId === engine.player.id;

  /*
   * The strategist may name a player the engine never shortlisted, so the card
   * player is built from whichever source knows him. Falling back to the audit
   * record's own copy of the board keeps this working for exactly that case.
   */
  const shortlisted = result.recommendations.find(
    (recommendation) => recommendation.player.id === chosenId,
  );
  const briefCandidate = decision.audit.brief.candidates.find(
    (candidate) => candidate.playerId === chosenId,
  );

  const primary: CardPlayer | null = shortlisted
    ? toCardPlayer(shortlisted)
    : briefCandidate
      ? {
          playerId: briefCandidate.playerId,
          name: briefCandidate.name,
          position: briefCandidate.position,
          team: briefCandidate.team,
          tier: briefCandidate.juancho.tier ?? 0,
          playersRemainingInTier: briefCandidate.juancho.playersRemainingInTier ?? 0,
          score: briefCandidate.juancho.score,
          survival: briefCandidate.survival.probability,
          survivalConfidence: briefCandidate.survival.confidence,
          firstSeedRank: briefCandidate.firstSeed.rank,
        }
      : base.primary;

  const chosenName = primary?.name ?? decision.final?.name ?? advice.primary.playerId;
  const firstAlternative = advice.alternatives[0];
  const alternativeName = firstAlternative ? nameOf(firstAlternative.playerId)?.name : null;

  return {
    ...base,
    state: confirmed ? 'ai_confirmed' : 'ai_override',
    /*
     * The strategist writes plain English by contract - `strategy` is one short
     * sentence naming the roster shape this pick serves - so the card quotes it
     * rather than paraphrasing a model that was asked to be readable.
     */
    plain: {
      headline: `Draft ${chosenName}`,
      why: advice.strategy || advice.reasons?.[0]?.detail || base.plain?.why || '',
      ifYouWait: describeAvailability({
        probability: primary?.survival ?? null,
        modeled: primary?.survival !== null && primary?.survival !== undefined,
        picksUntilTurn: result.picksUntilNextUserPick,
      }),
      alternative: alternativeName
        ? `Alternative: ${alternativeName}${firstAlternative.reasoning ? ` — ${firstAlternative.reasoning}` : ''}`
        : base.plain?.alternative ?? null,
      position: base.plain?.position ?? null,
    },
    primary,
    source: 'ai',
    urgency: aiUrgency(advice) ?? base.urgency,
    reasons: (advice.reasons ?? []).slice(0, 3).map((reason) => ({
      code: reason.code,
      text: reason.detail,
    })),
    // Evidence stays the engine's: those are measurements, not opinions, and
    // they describe the player now on the card.
    evidence: shortlisted ? engineEvidence(shortlisted, result) : base.evidence,
    alternatives: advice.alternatives.slice(0, 2).map((alternative) => {
      const resolved = nameOf(alternative.playerId);
      return {
        playerId: alternative.playerId,
        name: resolved?.name ?? alternative.playerId,
        position: resolved?.position ?? null,
        reason: alternative.reasoning || null,
        survival: survivalOf(alternative.playerId),
      };
    }),
    enginePick:
      confirmed || !engine
        ? null
        : { playerId: engine.player.id, name: engine.player.name },
    aiConfidence: Math.round((advice.confidence ?? 0) * 100),
    counterargument: advice.strongestCounterargument
      ? {
          objection: advice.strongestCounterargument,
          answer: advice.whyRecommendationStillWins ?? null,
        }
      : null,
    strategy: advice.strategy ?? null,
    expectedNextPickPlan: advice.expectedNextPickPlan ?? null,
    note: null,
    advice,
    decision,
  };
}

function toCardPlayer(recommendation: DraftRecommendation): CardPlayer {
  return {
    playerId: recommendation.player.id,
    name: recommendation.player.name,
    position: recommendation.player.position,
    team: recommendation.player.team ?? null,
    tier: recommendation.tier,
    playersRemainingInTier: recommendation.playersRemainingInTier,
    score: recommendation.score,
    survival: recommendation.availableNextPickProbability,
    survivalConfidence: recommendation.nextPickConfidence,
    firstSeedRank: recommendation.draftRoomRank,
  };
}

/**
 * The engine's own timing signal, in words.
 *
 * `DRAFT_NOW` and `WAIT` are the engine's vocabulary and stay exactly as they
 * are; this only translates them, and says which layer said it, so the card can
 * never present the engine's timing as the strategist's.
 */
function engineUrgency(recommendation: DraftRecommendation): RecommendationCard['urgency'] {
  if (recommendation.action === 'DRAFT_NOW') {
    return { label: 'Draft now', tone: 'now', source: 'engine' };
  }
  return { label: 'Can wait', tone: 'calm', source: 'engine' };
}

function aiUrgency(advice: StrategistAdvice): RecommendationCard['urgency'] {
  switch (advice.urgency) {
    case 'must_take_now':
      return { label: 'Take him now', tone: 'now', source: 'ai' };
    case 'likely_to_return':
      return { label: 'Likely to come back', tone: 'soon', source: 'ai' };
    case 'neutral':
      return { label: 'Timing is not the issue', tone: 'calm', source: 'ai' };
    default:
      return null;
  }
}

/**
 * The handful of measurements worth putting on the card itself.
 *
 * Four, in the drafter's own words. "Tier 12 · 8 left" is a fact about our
 * data structures; "8 similar players left" is a fact about his draft. The tier
 * number itself is in the drawer for anyone who wants to check.
 */
function engineEvidence(
  recommendation: DraftRecommendation,
  result: DraftRecommendationResult,
): CardEvidence[] {
  const evidence: CardEvidence[] = [];
  const position = recommendation.player.position;

  if (recommendation.availableNextPickProbability !== null) {
    const confident = recommendation.nextPickConfidence === 'high';
    evidence.push({
      label: "Chance he's still available",
      value: `${confident ? '' : '≈'}${Math.round(recommendation.availableNextPickProbability)}%`,
      detail:
        recommendation.picksUntilNextUserPick === 0
          ? 'You select again immediately.'
          : `${recommendation.nextPickExplanation.picksBeforeNextSelection ?? '—'} teams pick before you do, ${recommendation.insight.opponentTeamsNeedingPosition} of them needing a ${position}.`,
    });
  } else {
    evidence.push({
      label: "Chance he's still available",
      value: '—',
      detail: 'Not enough simulation data for this player.',
    });
  }

  const remaining = recommendation.playersRemainingInTier;
  evidence.push({
    label: 'Others like him left',
    value: remaining <= 0 ? 'None' : String(remaining),
    detail:
      remaining <= 1
        ? `He is the last ${position} of this quality on the board.`
        : `${remaining} similarly rated ${position}s remain.`,
  });

  evidence.push({
    label: 'Improves your starting lineup',
    value:
      recommendation.components.marginalStartingValue > 0.5
        ? `+${Math.round(recommendation.components.marginalStartingValue)} pts`
        : 'Bench only',
    detail:
      recommendation.components.marginalStartingValue > 0.5
        ? `Over a season, against a replacement projected at ${Math.round(recommendation.raw.replacementProjection)} points.`
        : 'Every starting spot he could fill is already taken.',
  });

  const expert = expertRank(recommendation, result);
  if (expert) evidence.push(expert);

  return evidence;
}

/**
 * The expert rank, from whichever source is entitled to speak about him.
 *
 * First Seed publishes an OVERALL board and covers no kickers or defenses;
 * FantasyPros supplies those, and publishes a POSITIONAL rank. They are
 * different units, so a kicker reads "K4" rather than "#4" - showing a
 * positional rank as an overall one would put a kicker four places from the top
 * of the draft.
 */
function expertRank(
  recommendation: DraftRecommendation,
  result: DraftRecommendationResult,
): CardEvidence | null {
  const position = recommendation.player.position;
  if (recommendation.draftRoomRank !== null) {
    const gap = recommendation.insight.firstSeedRankGap ?? 0;
    return {
      label: 'Expert rank',
      value: `#${recommendation.draftRoomRank}`,
      detail:
        gap > 0 && recommendation.insight.bestAvailableFirstSeedRank !== null
          ? `First Seed. Their best available is #${recommendation.insight.bestAvailableFirstSeedRank}, so this reaches ${gap} ${gap === 1 ? 'place' : 'places'} past the board.`
          : 'First Seed.',
    };
  }

  const supplemental = result.internals?.supplementalRankOf(recommendation.player.id);
  if (supplemental) {
    const label = position === 'DEF' ? 'DST' : position;
    return {
      label: 'Expert rank',
      value: `${label}${supplemental.positionRank}`,
      detail: 'FantasyPros. First Seed does not rank this position.',
    };
  }

  if (position === 'K' || position === 'DEF') {
    return {
      label: 'Expert rank',
      value: 'Unranked',
      detail: 'No expert board covers this player.',
    };
  }
  return null;
}
