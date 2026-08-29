/**
 * Asking the strategist about selections that already happened.
 *
 * The corpus pins the exact board, projections and player pool of three real
 * mocks, so a brief built at any of our selections is byte-identical to the one
 * the live path would have produced at that moment. That makes it possible to
 * judge the strategist on real decisions before it is allowed to make any.
 *
 * Two things this deliberately does NOT do. It never puts the answer into the
 * recommendation path - the outcome is computed and printed, not applied. And
 * it never evaluates every selection by default: forty-five paid calls to look
 * at three interesting ones is a waste, so the selections that are actually in
 * dispute are found first and everything else is left alone.
 */
import type { DraftRoomRankingSnapshot, ProjectionSnapshot } from '../../../data/types';
import type { CanonicalPlayerMap } from '../../../players/types';
import type { SleeperDraft, SleeperLeague, SleeperRoster } from '../../../sleeper/types';
import { buildBriefAtPick, ourPickNumbers } from '../../benchmark/brief-replay';
import type { RegressionCase } from '../../benchmark/case';
import { resolveStrategistDecision, type StrategistDecision } from '../audit';
import { buildStrategistPromptContext } from '../prompt-context';
import type { BriefCandidate, DraftBrief } from '../types';
import { cacheKey, readCached, writeCached, type CachedCall } from './cache';
import { AnthropicStrategist, strategistFingerprint } from './client';
import type { RecommendationTool } from './schema';
import { describeProblems, validateStrategistResponse } from './validate';

/** Why a selection was picked out for evaluation. */
export type InterestReason =
  /** Juancho reaches meaningfully past First Seed's best available. */
  | 'deviates_from_first_seed'
  /** Some candidate's completed-roster simulation beats the recommendation's. */
  | 'simulation_disagrees'
  /** The top two are close enough that the tie-breaks decided it. */
  | 'close_call'
  /** A tier we still need is about to empty. */
  | 'tier_at_risk'
  /** The room is consuming a position faster than normal. */
  | 'run_active';

export interface InterestingPick {
  overallPick: number;
  round: number;
  reasons: InterestReason[];
  /** Higher is more worth spending a call on. */
  score: number;
  summary: string;
}

/** Reaching this far past the board is a deviation worth examining. */
const DEVIATION_RANKS = 5;
/** A raw plan this much better than the recommendation's is a real dispute. */
const SIMULATION_MARGIN = 2;
/** Decision values within this are a coin-flip the tie-breaks resolved. */
const CLOSE_CALL_MARGIN = 5;

export interface EvaluationInput {
  regression: RegressionCase;
  projections: ProjectionSnapshot;
  roomRankings: DraftRoomRankingSnapshot | null;
  players: CanonicalPlayerMap;
  league: SleeperLeague;
  draft: SleeperDraft;
  rosters: SleeperRoster[];
}

/**
 * Finds the selections where the decision was genuinely in doubt.
 *
 * A pick where First Seed, our simulation and our ranking all agree teaches
 * nothing about the strategist - it can only match or be wrong. The disputes
 * are where its judgement is actually visible.
 */
export function findInterestingPicks(input: EvaluationInput): InterestingPick[] {
  const found: InterestingPick[] = [];

  for (const overallPick of ourPickNumbers(input.regression)) {
    const brief = buildBriefAtPick(input, overallPick);
    if (!brief) continue;
    const recommended = brief.deterministic.recommended;
    if (!recommended) continue;

    const reasons: InterestReason[] = [];
    const notes: string[] = [];

    const chosen = brief.candidates.find((entry) => entry.playerId === recommended.playerId);
    const gap = chosen?.firstSeed.rankGapFromBestAvailable ?? 0;
    if (gap >= DEVIATION_RANKS) {
      reasons.push('deviates_from_first_seed');
      notes.push(
        `reaches ${gap} past ${brief.deterministic.bestAvailableFirstSeed?.name ?? 'the board'}`,
      );
    }

    const betterPlan = brief.candidates
      .filter((entry) => (entry.juancho.planValueVsRecommended ?? 0) > SIMULATION_MARGIN)
      .sort(
        (a, b) =>
          (b.juancho.planValueVsRecommended ?? 0) - (a.juancho.planValueVsRecommended ?? 0),
      )[0];
    if (betterPlan) {
      reasons.push('simulation_disagrees');
      notes.push(
        `${betterPlan.name} plans +${betterPlan.juancho.planValueVsRecommended} yet ranks ${betterPlan.juancho.recommendationRank ?? '-'}`,
      );
    }

    const second = brief.deterministic.top[1];
    if (second && Math.abs(second.decisionValueDelta) <= CLOSE_CALL_MARGIN) {
      reasons.push('close_call');
      notes.push(`${second.name} within ${Math.abs(second.decisionValueDelta)}`);
    }

    const needed = new Set(
      brief.ourTeam.needs
        .filter((need) => ['critical', 'high', 'medium'].includes(need.depthNeed))
        .map((need) => need.position),
    );
    const cliff = brief.room.tierCliffs.find((entry) => entry.atRisk && needed.has(entry.position));
    if (cliff) {
      reasons.push('tier_at_risk');
      notes.push(`${cliff.position} tier ${cliff.tier} down to ${cliff.playersRemainingInTier}`);
    }

    const run = brief.room.positionalRuns.find((entry) => entry.isRun);
    if (run) {
      reasons.push('run_active');
      notes.push(`${run.position} run at ${run.intensity}x`);
    }

    if (reasons.length === 0) continue;
    found.push({
      overallPick,
      round: brief.draft.currentRound,
      reasons,
      // A dispute between our two sources of truth is worth more than a live
      // run, which happens constantly and settles nothing on its own.
      score:
        (reasons.includes('deviates_from_first_seed') ? 3 : 0) +
        (reasons.includes('simulation_disagrees') ? 3 : 0) +
        (reasons.includes('close_call') ? 2 : 0) +
        (reasons.includes('tier_at_risk') ? 2 : 0) +
        (reasons.includes('run_active') ? 1 : 0),
      summary: notes.join('; '),
    });
  }

  return found.sort((a, b) => b.score - a.score || a.overallPick - b.overallPick);
}

export interface EvaluatedPick {
  overallPick: number;
  round: number;
  brief: DraftBrief;
  call: CachedCall;
  /** True when the answer came from disk and cost nothing. */
  fromCache: boolean;
  decision: StrategistDecision;
  firstSeedBest: DraftBrief['deterministic']['bestAvailableFirstSeed'];
  deterministic: DraftBrief['deterministic']['recommended'];
  /** The strategist's pick as it appears on the board, when it is a real one. */
  chosen: BriefCandidate | null;
  alternatives: (BriefCandidate | null)[];
}

export interface EvaluateOptions {
  strategist: AnthropicStrategist;
  model: string;
  /** Supplied so nothing in the engine has to read the clock. */
  now: string;
  /** Set to skip the cache and pay for a fresh answer. */
  refresh?: boolean;
}

/**
 * Re-checks an answer against the contract, however it arrived.
 *
 * Validity is a property of the RESPONSE, not of when it was received. Answers
 * cached before the validator existed - including the one that omitted
 * `decision` entirely - would otherwise keep being served as though they were
 * sound, and tightening the contract later would silently not apply to them.
 *
 * Cheap enough to run on every read, and it means the cache can never be a way
 * around the rules.
 */
/** The repair story of a call, for the audit record. Null when it went first time. */
function repairRecordFor(call: CachedCall) {
  const attempts = call.attempts ?? [];
  if (attempts.length <= 1) return null;
  return {
    attempted: true,
    firstAttemptProblems: attempts[0]?.problems ?? [],
    succeeded: call.advice !== null,
    attempts: attempts.length,
  };
}

function enforceContract(
  call: CachedCall,
  brief: DraftBrief,
  tool: RecommendationTool,
): CachedCall {
  if (call.response === null || call.response === undefined) {
    return { ...call, problems: call.problems ?? [] };
  }
  const validation = validateStrategistResponse(
    call.response,
    brief.candidates.map((candidate) => candidate.playerId),
    tool,
  );
  if (validation.ok) return { ...call, problems: [] };
  return {
    ...call,
    advice: null,
    response: null,
    rawResponse: call.response,
    problems: validation.problems,
    error: `The strategist's response did not satisfy the contract. ${describeProblems(validation.problems)}`,
  };
}

/**
 * Evaluates one selection, reusing a stored answer when there is one.
 *
 * The cache key is the exact payload the model would be sent, so a change to
 * the brief, the compression or the playbook produces a miss rather than a
 * stale answer attributed to the new code.
 */
export async function evaluatePick(
  input: EvaluationInput,
  overallPick: number,
  options: EvaluateOptions,
): Promise<EvaluatedPick | null> {
  const brief = buildBriefAtPick(input, overallPick);
  if (!brief) return null;

  /*
   * Keyed on the payload this strategist will actually send, options included.
   * Building it with defaults gave blind and open runs the same key, so a blind
   * experiment was quietly answered from the open cache.
   */
  const payload = buildStrategistPromptContext(brief, options.strategist.promptContext);
  const key = cacheKey({ model: options.model, payload, tool: options.strategist.tool });
  const label =
    `${input.regression.draftId} p${overallPick} ${strategistFingerprint(options.model)}` +
    (options.strategist.isBlind ? ' blind' : '') +
    (options.strategist.isConcise ? ' concise' : '') +
    (options.strategist.isCompact ? ' compact' : '');

  const cached = options.refresh ? null : readCached(key);
  const call = enforceContract(
    cached ?? writeCached(key, label, await options.strategist.call(brief), options.now),
    brief,
    options.strategist.tool,
  );

  const decision = resolveStrategistDecision({
    brief,
    advice: call.advice,
    responseProblems: call.problems,
    repair: repairRecordFor(call),
    latencyMs: call.latencyMs,
    strategistId: `anthropic:${options.model}`,
  });

  const find = (playerId: string | undefined) =>
    playerId ? brief.candidates.find((entry) => entry.playerId === playerId) ?? null : null;

  return {
    overallPick,
    round: brief.draft.currentRound,
    brief,
    call,
    fromCache: cached !== null,
    decision,
    firstSeedBest: brief.deterministic.bestAvailableFirstSeed,
    deterministic: brief.deterministic.recommended,
    chosen: find(call.response?.recommendedPlayerId),
    alternatives: (call.response?.alternatives ?? []).map((alternative) =>
      find(alternative.playerId),
    ),
  };
}
