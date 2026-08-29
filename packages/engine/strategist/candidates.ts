/**
 * Which available players the strategist actually gets to see.
 *
 * One rule governs this file: never hide the correct player. A pool trimmed for
 * token cost can only be wrong in one direction - a strategist that never saw
 * the right name cannot pick him, and no amount of reasoning recovers from that.
 *
 * So the pool is a UNION of several independent selection rules rather than a
 * single ranked cut, and every candidate records which rules put it there. Cost
 * can be optimised later against `inclusionReasons`; a silent omission cannot
 * be optimised at all.
 */
import type { CanonicalPlayerMap, Position } from '../../players/types';
import type { DraftDecisionInternals, PlannedCandidate } from '../draft/internals';
import type { PlannablePlayer } from '../draft/roster-plan';
import type { DraftRecommendationResult } from '../draft/types';
import type { BriefCandidate, CandidateInclusionReason } from './types';

/**
 * How the candidate pool is chosen.
 *
 * Every number here is a floor on coverage, never a cap: the pool is the union
 * of all of them, so raising one can only add players. `maxCandidates` is the
 * single exception and defaults to off.
 */
export interface CandidatePoolOptions {
  /** Best players on First Seed's board, whatever position they play. */
  topOverall: number;
  /** Best at each position, so a real need is never ranked out of the pool. */
  topPerPosition: number;
  /** Whole tiers at each position, counting from the best one still available. */
  tierDepth: number;
  /** Everyone Juancho planned - its shortlist, not just its recommendations. */
  includeJuanchoShortlist: boolean;
  /**
   * A hard ceiling, applied last and only if set.
   *
   * Off by default. When it is set, Juancho's own recommendations are kept
   * regardless, because dropping the deterministic pick from the pool would
   * make the strategist's disagreement with it meaningless.
   */
  maxCandidates: number | null;
}

export const DEFAULT_CANDIDATE_POOL: CandidatePoolOptions = {
  topOverall: 60,
  topPerPosition: 12,
  tierDepth: 2,
  includeJuanchoShortlist: true,
  maxCandidates: null,
};

export function buildCandidates({
  internals,
  players,
  result,
  options,
}: {
  internals: DraftDecisionInternals;
  players: CanonicalPlayerMap;
  result: DraftRecommendationResult;
  options: CandidatePoolOptions;
}): BriefCandidate[] {
  const pool = internals.candidatePool;
  const reasons = new Map<string, Set<CandidateInclusionReason>>();
  const include = (playerId: string, reason: CandidateInclusionReason) => {
    const existing = reasons.get(playerId) ?? new Set<CandidateInclusionReason>();
    existing.add(reason);
    reasons.set(playerId, existing);
  };

  const ranked = [...pool].sort((a, b) => a.consensusRank - b.consensusRank);
  for (const candidate of ranked.slice(0, options.topOverall)) {
    include(candidate.playerId, 'top_first_seed');
  }

  const byPosition = new Map<Position, PlannablePlayer[]>();
  for (const candidate of ranked) {
    byPosition.set(candidate.position, [...(byPosition.get(candidate.position) ?? []), candidate]);
  }
  for (const [, list] of byPosition) {
    for (const candidate of list.slice(0, options.topPerPosition)) {
      include(candidate.playerId, 'top_at_position');
    }
    // Whole tiers, counted from the best one still on the board. A tier is
    // where the cliff is, so seeing part of one hides exactly the comparison a
    // strategist needs to make.
    const tiers = [
      ...new Set(
        list
          .map((candidate) => internals.tierOf(candidate.playerId)?.tier)
          .filter((tier): tier is number => tier !== undefined),
      ),
    ].sort((a, b) => a - b);
    const wanted = new Set(tiers.slice(0, Math.max(0, options.tierDepth)));
    for (const candidate of list) {
      const tier = internals.tierOf(candidate.playerId)?.tier;
      if (tier !== undefined && wanted.has(tier)) include(candidate.playerId, 'current_tier');
    }
  }

  if (options.includeJuanchoShortlist) {
    for (const candidate of pool) {
      if (internals.plannedOf(candidate.playerId)) {
        include(candidate.playerId, 'juancho_shortlist');
      }
    }
  }
  // Juancho's own ranked recommendations are never optional: without them the
  // strategist cannot be said to have disagreed with anything.
  for (const recommendation of result.recommendations) {
    include(recommendation.player.id, 'juancho_recommendation');
  }
  // Nor is the kicker or defense the lineup still legally requires.
  for (const candidate of pool) {
    if (candidate.position === 'K' || candidate.position === 'DEF') {
      include(candidate.playerId, 'required_slot_filler');
    }
  }

  const recommendationRank = new Map(
    result.recommendations.map((recommendation, index) => [recommendation.player.id, index + 1]),
  );
  const recommendedId = result.recommendations[0]?.player.id ?? null;
  const recommendedPlan = recommendedId === null ? undefined : internals.plannedOf(recommendedId);
  const poolById = new Map(pool.map((candidate) => [candidate.playerId, candidate]));

  let selected = [...reasons.keys()].filter((playerId) => poolById.has(playerId));
  if (options.maxCandidates !== null && selected.length > options.maxCandidates) {
    const protectedIds = new Set(
      selected.filter((playerId) => reasons.get(playerId)?.has('juancho_recommendation')),
    );
    const rest = selected
      .filter((playerId) => !protectedIds.has(playerId))
      .sort(
        (a, b) =>
          (poolById.get(a)?.consensusRank ?? Infinity) - (poolById.get(b)?.consensusRank ?? Infinity),
      );
    selected = [
      ...protectedIds,
      ...rest.slice(0, Math.max(0, options.maxCandidates - protectedIds.size)),
    ];
  }

  return selected
    .map((playerId) =>
      describeCandidate({
        playerId,
        internals,
        players,
        result,
        recommendationRank,
        recommendedPlan,
        reasons: [...(reasons.get(playerId) ?? [])],
      }),
    )
    .filter((candidate): candidate is BriefCandidate => candidate !== null)
    .sort(
      (a, b) =>
        (a.firstSeed.rank ?? Infinity) - (b.firstSeed.rank ?? Infinity) ||
        (a.juancho.boardRank ?? Infinity) - (b.juancho.boardRank ?? Infinity),
    );
}

function describeCandidate({
  playerId,
  internals,
  players,
  result,
  recommendationRank,
  recommendedPlan,
  reasons,
}: {
  playerId: string;
  internals: DraftDecisionInternals;
  players: CanonicalPlayerMap;
  result: DraftRecommendationResult;
  recommendationRank: Map<string, number>;
  /** The plan behind Juancho's own pick, which everything else is measured against. */
  recommendedPlan: PlannedCandidate | undefined;
  reasons: CandidateInclusionReason[];
}): BriefCandidate | null {
  const player = players.byId.get(playerId);
  const projection = internals.projectionOf(playerId);
  if (!player || !projection) return null;

  const firstSeed = internals.firstSeedOf(playerId);
  const planned = internals.plannedOf(playerId);
  const survival = internals.survivalOf(playerId);
  const tier = internals.tierOf(playerId);
  const rank = recommendationRank.get(playerId) ?? null;
  const recommendation = rank === null ? null : result.recommendations[rank - 1];
  const best = internals.bestAvailableConsensusRank;

  return {
    playerId,
    sleeperId: player.externalIds.sleeper ?? null,
    name: player.name,
    position: player.position,
    team: player.team,
    age: player.age,
    yearsExperience: player.yearsExperience,
    status: player.status,
    firstSeed: {
      rank: firstSeed?.rank ?? null,
      // First Seed's published number, before this league's scoring is applied.
      projection: internals.sourceProjectionOf(playerId)?.projection ?? null,
      valueDelta: firstSeed?.firstSeedValueDelta ?? null,
      expertRank: firstSeed?.upstreamExpertRank ?? null,
      landmineScore: firstSeed?.firstSeedLandmineScore ?? null,
      rankGapFromBestAvailable:
        firstSeed && best !== null ? Math.round(firstSeed.rank - best) : null,
    },
    juancho: {
      boardRank: internals.juanchoBoardRankOf(playerId) ?? null,
      positionalRank: internals.positionalRankOf(playerId) ?? null,
      projectedPoints: round1(projection.projection),
      tier: tier?.tier ?? null,
      playersRemainingInTier: tier ? internals.playersRemainingInTier(playerId) : null,
      recommendationRank: rank,
      score: recommendation?.score ?? null,
      action: recommendation?.action ?? null,
      planValue: planned ? round1(planned.planTotal) : null,
      planValueVsRecommended:
        planned && recommendedPlan ? round1(planned.planTotal - recommendedPlan.planTotal) : null,
      decisionValue: planned ? round1(planned.decisionValue) : null,
      decisionValueVsRecommended:
        planned && recommendedPlan
          ? round1(planned.decisionValue - recommendedPlan.decisionValue)
          : null,
      immediateRosterGain: planned
        ? round1(planned.immediate - internals.currentRosterValue)
        : null,
    },
    survival: {
      probability: survival.value,
      confidence: survival.confidence,
      interveningTeamsWithNeed: survival.teamsWithNeed,
      interveningDemand: round1(survival.demand),
    },
    dataWarning: internals.dataWarningOf(playerId) ?? null,
    inclusionReasons: reasons,
  };
}


const round1 = (value: number) => Math.round(value * 10) / 10;
