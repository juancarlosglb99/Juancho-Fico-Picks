/**
 * The right-hand rail: what happens between now and our next turn.
 *
 * The question this answers is not "who is best" - the card answers that - but
 * "what will still be here". Three things decide that: which of the players we
 * are considering are unlikely to survive, which tiers are about to break, and
 * which of the teams ahead of us actually want what we want.
 *
 * The last one is filtered hard on purpose. Eleven teams pick before our next
 * turn in a twelve-team league, and listing all eleven is a table of contents,
 * not a warning. Only teams with an open starting slot at a position WE still
 * need can change our plan, so only those get a row.
 */
import { groupSurvival, likelyBestAvailable } from '../engine/draft/joint-availability';
import type { DraftRecommendationResult } from '../engine/draft/types';
import type { DraftBrief } from '../engine/strategist/types';
import type { Confidence } from '../engine/context/types';
import type { Position } from '../players/types';

/** Below this, a player is worth flagging as unlikely to come back. */
const AT_RISK_CEILING = 55;
/** Above this, the rail says plainly that waiting is safe. */
const SAFE_FLOOR = 80;
/** How far down the engine's shortlist the rail looks. */
const CONSIDERED = 8;

export interface RiskRow {
  playerId: string;
  name: string;
  position: Position;
  survival: number;
  confidence: Confidence;
  engineRank: number;
  tier: number;
  playersRemainingInTier: number;
}

export interface CliffRow {
  position: Position;
  tier: number;
  playersRemainingInTier: number;
  /** Projection points between this tier's floor and the next tier's ceiling. */
  gapAfterTier: number;
  bestRemaining: { playerId: string; name: string; projectedPoints: number } | null;
  /** Chance the tier still holds somebody when our turn comes. */
  tierSurvives: number | null;
  atRisk: boolean;
  /** True when we still have a starting slot open at this position. */
  weNeedIt: boolean;
}

export interface ThreatRow {
  rosterId: number | null;
  teamName: string;
  selections: number[];
  /** Only the positions we ourselves still need. */
  competingFor: { position: Position; openStartingSlots: number }[];
}

export interface NextUpModel {
  ourNextPick: number | null;
  picksUntilTurn: number | null;
  /** True when nobody picks in between, which makes every estimate certain. */
  backToBack: boolean;
  atRisk: RiskRow[];
  likelyToReturn: RiskRow[];
  cliffs: CliffRow[];
  threats: ThreatRow[];
  /** Who the simulation most often leaves on the board at our next turn. */
  likelyBestAvailable: { playerId: string; name: string; position: Position; frequency: number }[];
  runs: number | null;
}

export function buildNextUp({
  result,
  brief,
  teamNameFor,
}: {
  result: DraftRecommendationResult;
  brief: DraftBrief | null;
  /**
   * Resolves a roster id to the name the drafter recognises.
   *
   * The brief names a team only when Sleeper gave it one, which a mock draft
   * never does. Passing the resolver in keeps "Roster 7" out of a rail whose
   * whole purpose is to say WHO is about to take your receiver.
   */
  teamNameFor?: (rosterId: number | null) => string | null;
}): NextUpModel | null {
  const internals = result.internals;
  if (!internals) return null;

  const picksUntilTurn = result.picksUntilNextUserPick;
  const backToBack = picksUntilTurn === 0;

  const considered = result.recommendations.slice(0, CONSIDERED);
  const rows: RiskRow[] = considered
    .map((recommendation, index) => ({
      playerId: recommendation.player.id,
      name: recommendation.player.name,
      position: recommendation.player.position,
      // Null unless estimated, so an unmodelled player never reads as safe.
      survival: recommendation.availableNextPickProbability,
      confidence: recommendation.nextPickConfidence,
      engineRank: index + 1,
      tier: recommendation.tier,
      playersRemainingInTier: recommendation.playersRemainingInTier,
    }))
    .filter((row): row is RiskRow => row.survival !== null);

  const ourOpenPositions = new Set<Position>(
    (brief?.ourTeam.needs ?? [])
      .filter((need) => need.openStartingSlots > 0)
      .map((need) => need.position),
  );

  const outcomes = internals.roomOutcomes;

  return {
    ourNextPick: result.nextUserPick,
    picksUntilTurn,
    backToBack,
    atRisk: rows
      .filter((row) => row.survival <= AT_RISK_CEILING)
      .sort((a, b) => a.survival - b.survival)
      .slice(0, 5),
    likelyToReturn: rows
      .filter((row) => row.survival >= SAFE_FLOOR)
      .sort((a, b) => b.survival - a.survival)
      .slice(0, 4),
    cliffs: buildCliffs(internals, brief, ourOpenPositions),
    threats: buildThreats(brief, ourOpenPositions, teamNameFor),
    likelyBestAvailable: outcomes
      ? likelyBestAvailable(outcomes, { limit: 5 }).map((entry) => ({
          playerId: entry.playerId,
          name: internals.playerOf(entry.playerId)?.name ?? entry.playerId,
          position: internals.playerOf(entry.playerId)?.position ?? 'UNKNOWN',
          frequency: entry.frequency,
        }))
      : [],
    runs: outcomes?.runs ?? null,
  };
}

function buildCliffs(
  internals: NonNullable<DraftRecommendationResult['internals']>,
  brief: DraftBrief | null,
  ourOpenPositions: Set<Position>,
): CliffRow[] {
  if (!brief) return [];
  const outcomes = internals.roomOutcomes;

  return brief.room.tierCliffs
    .map((cliff) => {
      const sameTier = internals.candidatePool
        .filter(
          (candidate) =>
            candidate.position === cliff.position &&
            (internals.tierOf(candidate.playerId)?.tier ?? null) === cliff.tier,
        )
        .map((candidate) => candidate.playerId);
      const group =
        outcomes && sameTier.length > 0 ? groupSurvival(outcomes, sameTier) : null;
      return {
        position: cliff.position,
        tier: cliff.tier,
        playersRemainingInTier: cliff.playersRemainingInTier,
        gapAfterTier: cliff.gapAfterTier,
        bestRemaining: cliff.bestRemaining,
        tierSurvives: group?.atLeastOne ?? null,
        atRisk: cliff.atRisk,
        weNeedIt: ourOpenPositions.has(cliff.position),
      };
    })
    /*
     * A tier we cannot start anybody from is not a cliff we are standing on.
     * Ordering by need first, then by how close the tier is to emptying, keeps
     * the rail about our own draft rather than about the room's.
     */
    .sort((a, b) => {
      if (a.weNeedIt !== b.weNeedIt) return a.weNeedIt ? -1 : 1;
      if (a.atRisk !== b.atRisk) return a.atRisk ? -1 : 1;
      return b.gapAfterTier - a.gapAfterTier;
    })
    .slice(0, 4);
}

function buildThreats(
  brief: DraftBrief | null,
  ourOpenPositions: Set<Position>,
  teamNameFor?: (rosterId: number | null) => string | null,
): ThreatRow[] {
  if (!brief || ourOpenPositions.size === 0) return [];

  return brief.room.teamsBeforeOurNextPick
    .map((team) => ({
      rosterId: team.rosterId,
      teamName:
        teamNameFor?.(team.rosterId) ??
        team.teamName ??
        (team.rosterId !== null ? `Roster ${team.rosterId}` : 'Unknown team'),
      selections: team.selections,
      competingFor: team.needs
        .filter((need) => need.openStartingSlots > 0 && ourOpenPositions.has(need.position))
        .map((need) => ({
          position: need.position,
          openStartingSlots: need.openStartingSlots,
        }))
        .sort((a, b) => b.openStartingSlots - a.openStartingSlots),
    }))
    .filter((team) => team.competingFor.length > 0)
    .sort(
      (a, b) =>
        b.competingFor.length - a.competingFor.length ||
        (a.selections[0] ?? 0) - (b.selections[0] ?? 0),
    )
    .slice(0, 5);
}
