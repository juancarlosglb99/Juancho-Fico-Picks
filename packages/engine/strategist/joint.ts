/**
 * The sequence-aware half of availability.
 *
 * Marginal survival answers "does this player reach us". It cannot answer "will
 * either of these two reach us", and at pick 52 the strategist tried to answer
 * that anyway - arguing from Warren at 10% and Kraft at 72% that "two TEs
 * cannot both survive", which is a statement about their joint distribution
 * inferred from numbers that do not contain one.
 *
 * The runs contain it. This selects the handful of comparisons a decision
 * actually turns on and counts them straight out of the simulated futures.
 *
 * Deliberately not a matrix. Every pair costs tokens and attention, and the
 * board is two hundred players - the pairs that matter are the ones the pick is
 * genuinely being decided between:
 *
 *   - Juancho's recommendation against each of its close alternatives
 *   - First Seed's best available against Juancho's choice
 *   - the top two at each position inside the tier that is about to break
 *
 * which is ten to fifteen rows, not twenty thousand.
 */
import type { Position } from '../../players/types';
import type { DraftDecisionInternals } from '../draft/internals';
import {
  groupSurvival,
  jointOutcome,
  likelyBestAvailable,
} from '../draft/joint-availability';
import type { BriefCandidate } from './types';

/** How many of Juancho's ranked alternatives get paired against its pick. */
const ALTERNATIVES_PAIRED = 3;
/** How many positions get a same-tier pair. */
const TIER_PAIRS = 4;
/** How many "who is likely to be there" rows to carry. */
const BEST_AVAILABLE_DEPTH = 5;

export interface JointPair {
  /** Why this comparison is worth a row. */
  reason:
    | 'juancho_pick_vs_alternative'
    | 'first_seed_vs_juancho'
    | 'same_tier_alternatives';
  a: { playerId: string; name: string; position: Position };
  b: { playerId: string; name: string; position: Position };
  aSurvives: number;
  bSurvives: number;
  bothSurvive: number;
  atLeastOneSurvives: number;
  neitherSurvives: number;
  /** If A is gone by our turn, how often B is still there. */
  bSurvivesGivenAGone: number | null;
}

export interface TierOutlook {
  position: Position;
  tier: number;
  /** The players in that tier, best first. */
  members: { playerId: string; name: string; survives: number }[];
  /** Chance the tier still holds somebody when our turn comes. */
  atLeastOneRemains: number;
  /** Chance every member is still there. */
  allRemain: number;
  expectedSurvivors: number;
}

export interface FallbackOutlook {
  position: Position;
  /** The best player at this position who is NOT Juancho's recommendation. */
  playerId: string;
  name: string;
  survives: number;
  /** How often he is the best of his position left at our next selection. */
  isBestOfPositionAtNextPick: number;
}

export interface NextPickScenarios {
  runs: number;
  interveningSelections: number;
  /** How often each player is the best name left when our turn comes. */
  likelyBestAvailable: { playerId: string; name: string; position: Position; frequency: number }[];
  tiers: TierOutlook[];
  fallbacks: FallbackOutlook[];
}

export interface JointAvailability {
  pairs: JointPair[];
  scenarios: NextPickScenarios;
}

export function buildJointAvailability({
  internals,
  candidates,
  recommendedPlayerId,
  firstSeedBestPlayerId,
  rankedTop,
  openPositions,
  interveningSelections,
}: {
  internals: DraftDecisionInternals;
  candidates: BriefCandidate[];
  recommendedPlayerId: string | null;
  firstSeedBestPlayerId: string | null;
  /** Juancho's ranked recommendations, best first. */
  rankedTop: string[];
  /** Positions we can still start somebody at. */
  openPositions: Position[];
  interveningSelections: number;
}): JointAvailability | null {
  const outcomes = internals.roomOutcomes;
  if (!outcomes) return null;

  const byId = new Map(candidates.map((candidate) => [candidate.playerId, candidate]));
  const describe = (playerId: string) => {
    const candidate = byId.get(playerId);
    return candidate
      ? { playerId, name: candidate.name, position: candidate.position }
      : null;
  };

  /* ------------------------------------------------------------- the pairs */

  const pairs: JointPair[] = [];
  const seen = new Set<string>();
  const addPair = (aId: string, bId: string, reason: JointPair['reason']) => {
    if (aId === bId) return;
    // Order-independent, so the same comparison never appears twice under two
    // different headings.
    const key = [aId, bId].sort().join('|');
    if (seen.has(key)) return;
    const a = describe(aId);
    const b = describe(bId);
    if (!a || !b) return;
    const outcome = jointOutcome(outcomes, aId, bId);
    if (!outcome) return;
    seen.add(key);
    pairs.push({ reason, a, b, ...outcome });
  };

  if (recommendedPlayerId) {
    for (const alternative of rankedTop.slice(1, 1 + ALTERNATIVES_PAIRED)) {
      addPair(recommendedPlayerId, alternative, 'juancho_pick_vs_alternative');
    }
    if (firstSeedBestPlayerId) {
      addPair(firstSeedBestPlayerId, recommendedPlayerId, 'first_seed_vs_juancho');
    }
  }

  /*
   * The comparison pick 52 actually needed: the two players left in a tier that
   * is about to break, at a position we can still start.
   */
  const tiers = buildTierOutlooks({ internals, candidates, openPositions });
  for (const tier of tiers.slice(0, TIER_PAIRS)) {
    if (tier.members.length < 2) continue;
    addPair(tier.members[0].playerId, tier.members[1].playerId, 'same_tier_alternatives');
  }

  /* --------------------------------------------------------- the scenarios */

  const bestAvailable = likelyBestAvailable(outcomes, { limit: BEST_AVAILABLE_DEPTH })
    .map((entry) => {
      const described = describe(entry.playerId);
      return described ? { ...described, frequency: entry.frequency } : null;
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  const fallbacks: FallbackOutlook[] = [];
  for (const position of openPositions) {
    const atPosition = candidates
      .filter(
        (candidate) =>
          candidate.position === position && candidate.playerId !== recommendedPlayerId,
      )
      .sort(
        (a, b) =>
          (a.firstSeed.rank ?? Infinity) - (b.firstSeed.rank ?? Infinity) ||
          b.juancho.projectedPoints - a.juancho.projectedPoints,
      );
    const best = atPosition[0];
    if (!best) continue;
    const frequency =
      likelyBestAvailable(outcomes, { limit: 20, position }).find(
        (entry) => entry.playerId === best.playerId,
      )?.frequency ?? 0;
    fallbacks.push({
      position,
      playerId: best.playerId,
      name: best.name,
      survives: best.survival.probability ?? 100,
      isBestOfPositionAtNextPick: frequency,
    });
  }

  return {
    pairs,
    scenarios: {
      runs: outcomes.runs,
      interveningSelections,
      likelyBestAvailable: bestAvailable,
      tiers,
      fallbacks,
    },
  };
}

/**
 * The tier about to break at each position we can still start somebody at.
 *
 * Only the best tier still available, because that is the one a decision is
 * ever about - whether the tier below it is four deep or forty changes nothing
 * about whether to reach for this one now.
 */
function buildTierOutlooks({
  internals,
  candidates,
  openPositions,
}: {
  internals: DraftDecisionInternals;
  candidates: BriefCandidate[];
  openPositions: Position[];
}): TierOutlook[] {
  const outcomes = internals.roomOutcomes;
  if (!outcomes) return [];

  const outlooks: TierOutlook[] = [];
  for (const position of openPositions) {
    const atPosition = candidates
      .filter((candidate) => candidate.position === position && candidate.juancho.tier !== null)
      .sort((a, b) => b.juancho.projectedPoints - a.juancho.projectedPoints);
    const best = atPosition[0];
    if (!best) continue;

    const members = atPosition.filter((candidate) => candidate.juancho.tier === best.juancho.tier);
    const group = groupSurvival(
      outcomes,
      members.map((member) => member.playerId),
    );
    if (!group) continue;

    outlooks.push({
      position,
      tier: best.juancho.tier!,
      members: members.map((member) => ({
        playerId: member.playerId,
        name: member.name,
        survives: member.survival.probability ?? 100,
      })),
      atLeastOneRemains: group.atLeastOne,
      allRemain: group.allSurvive,
      expectedSurvivors: group.expectedSurvivors,
    });
  }

  // Thinnest first: the tier most likely to break is the one worth reading.
  return outlooks.sort((a, b) => a.atLeastOneRemains - b.atLeastOneRemains);
}
