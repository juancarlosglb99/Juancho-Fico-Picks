/**
 * The half of the drawer that is about what the ROOM does next.
 *
 * Tier structure, joint availability, which opponents genuinely threaten the
 * position, and the plan from this pick to the next turn. Every figure is
 * counted over the same simulated continuations the survival numbers come from,
 * which is what stops the drawer and the strategist's brief quoting different
 * odds about the same pair of players.
 */
import { groupSurvival, jointOutcome, likelyBestAvailable } from '../engine/draft/joint-availability';
import type { NeedLevel } from '../engine/draft/roster-state';
import type { DraftRecommendationResult } from '../engine/draft/types';
import type { DraftBrief } from '../engine/strategist/types';
import type { Position } from '../players/types';
import type {
  JointRow,
  JointView,
  NextPickPlanView,
  OpponentPressureRow,
  OpponentPressureView,
  PlanStep,
  TierCliffView,
  TierRow,
} from './player-analysis-types';

/** How deep the tier chart goes before it stops being a chart. */
const TIER_DEPTH = 14;

/* ------------------------------------------------------------ D. tier cliff */

export function buildTierCliff(
  playerId: string,
  position: Position,
  result: DraftRecommendationResult,
  brief: DraftBrief | null,
): TierCliffView | null {
  const internals = result.internals;
  if (!internals) return null;
  // A tier chart is about what is still on the board. Drawing one for a player
  // who has already been drafted would show a cliff he is no longer standing on.
  if (!internals.candidatePool.some((candidate) => candidate.playerId === playerId)) {
    return null;
  }

  const ranked = internals.candidatePool
    .filter((candidate) => candidate.position === position)
    .sort((a, b) => b.projection - a.projection)
    .slice(0, TIER_DEPTH);
  if (ranked.length < 2) return null;

  const subjectTier = internals.tierOf(playerId)?.tier ?? null;
  const rows: TierRow[] = ranked.map((candidate, index) => {
    const tier = internals.tierOf(candidate.playerId)?.tier ?? null;
    const nextTier =
      index + 1 < ranked.length
        ? internals.tierOf(ranked[index + 1].playerId)?.tier ?? null
        : null;
    return {
      playerId: candidate.playerId,
      name: internals.playerOf(candidate.playerId)?.name ?? candidate.playerId,
      projectedPoints: candidate.projection,
      tier,
      survival: internals.survivalOf(candidate.playerId).value,
      isSubject: candidate.playerId === playerId,
      cliffAfter: tier !== null && nextTier !== null && nextTier !== tier,
    };
  });

  const cliff = brief?.room.tierCliffs.find(
    (entry) => entry.position === position && entry.tier === subjectTier,
  );

  const sameTierIds = internals.candidatePool
    .filter(
      (candidate) =>
        candidate.position === position &&
        (internals.tierOf(candidate.playerId)?.tier ?? null) === subjectTier,
    )
    .map((candidate) => candidate.playerId);
  const outcomes = internals.roomOutcomes;
  const tierGroup =
    outcomes && sameTierIds.length > 0 ? groupSurvival(outcomes, sameTierIds) : null;

  return {
    position,
    rows,
    subjectTier,
    playersRemainingInSubjectTier: internals.playersRemainingInTier(playerId),
    gapAfterTier: cliff?.gapAfterTier ?? null,
    tierSurvives: tierGroup?.atLeastOne ?? null,
    atRisk: cliff?.atRisk ?? false,
  };
}

/* --------------------------------------------------------------- E. joint */

export function buildJoint(
  playerId: string,
  result: DraftRecommendationResult,
): JointView | null {
  const internals = result.internals;
  const outcomes = internals?.roomOutcomes;
  if (!internals || !outcomes) return null;

  const subjectVector = outcomes.survivalByRun.get(playerId);
  if (!subjectVector) return null;

  /*
   * Which comparisons are worth drawing: the engine's own pick, its next two
   * alternatives, and the best other player in the same tier. Every pair costs
   * a row of a drawer somebody is reading on a clock, and a full matrix of two
   * hundred players answers no question anyone asked.
   */
  const wanted: { playerId: string; reason: JointRow['reason'] }[] = [];
  const seen = new Set<string>([playerId]);
  const add = (id: string | undefined, reason: JointRow['reason']) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    wanted.push({ playerId: id, reason });
  };

  add(result.recommendations[0]?.player.id, 'engine_pick');
  add(result.recommendations[1]?.player.id, 'alternative');
  add(result.recommendations[2]?.player.id, 'alternative');

  const subject = internals.candidatePool.find((candidate) => candidate.playerId === playerId);
  const subjectTier = internals.tierOf(playerId)?.tier ?? null;
  if (subject && subjectTier !== null) {
    const sameTier = internals.candidatePool
      .filter(
        (candidate) =>
          candidate.position === subject.position &&
          candidate.playerId !== playerId &&
          (internals.tierOf(candidate.playerId)?.tier ?? null) === subjectTier,
      )
      .sort((a, b) => b.projection - a.projection)[0];
    add(sameTier?.playerId, 'same_tier');
  }

  const rows: JointRow[] = [];
  let subjectSurvives = 0;
  for (const entry of wanted) {
    const outcome = jointOutcome(outcomes, playerId, entry.playerId);
    if (!outcome) continue;
    subjectSurvives = outcome.aSurvives;
    const other = internals.playerOf(entry.playerId);
    rows.push({
      playerId: entry.playerId,
      name: other?.name ?? entry.playerId,
      position: other?.position ?? 'UNKNOWN',
      reason: entry.reason,
      bothSurvive: outcome.bothSurvive,
      atLeastOneSurvives: outcome.atLeastOneSurvives,
      neitherSurvives: outcome.neitherSurvives,
      otherSurvivesGivenSubjectGone: outcome.bSurvivesGivenAGone,
    });
  }
  if (rows.length === 0) return null;

  return { subjectSurvives, rows, runs: outcomes.runs };
}

/* --------------------------------------------------- F. opponent pressure */

/**
 * Which teams between us and our next turn actually threaten this position.
 *
 * Read from the brief rather than from the engine's `interveningTeams`, which
 * carries position counts and nothing else. The brief describes every team with
 * the same roster model used for our own - `openStartingSlots`, `depthNeed`,
 * `saturation` - so "they need a receiver" means exactly what it means about us.
 *
 * Teams with no need at the position are dropped entirely. A rail that lists
 * every team between here and our next pick is a list; the ones that change the
 * decision are the product.
 */
export function buildOpponentPressure(
  position: Position,
  result: DraftRecommendationResult,
  brief: DraftBrief | null,
  teamNameFor?: (rosterId: number | null) => string | null,
): OpponentPressureView | null {
  if (!result.internals || !brief) return null;
  const teams = brief.room.teamsBeforeOurNextPick;
  if (teams.length === 0) return null;

  const rows: OpponentPressureRow[] = teams.map((team) => {
    const need = team.needs.find((entry) => entry.position === position) ?? null;
    const openStartingSlots = need?.openStartingSlots ?? 0;
    const level: NeedLevel = need?.depthNeed ?? 'none';
    /*
     * Pressure orders the rows; it is not a probability. The probability is the
     * survival number, which comes from the simulation and is shown separately.
     */
    const pressure =
      openStartingSlots * 2 + NEED_WEIGHT[level] + Math.min(2, team.selections.length);
    return {
      rosterId: team.rosterId,
      teamName:
        teamNameFor?.(team.rosterId) ??
        team.teamName ??
        (team.rosterId !== null ? `Roster ${team.rosterId}` : 'Unknown team'),
      selections: team.selections,
      need: level,
      openStartingSlots,
      saturation: need?.saturation ?? 'none',
      pressure,
    };
  });

  const material = rows
    .filter((row) => row.openStartingSlots > 0 || row.need !== 'none')
    .sort((a, b) => b.pressure - a.pressure || a.selections[0] - b.selections[0]);
  if (material.length === 0) return null;

  return {
    position,
    rows: material,
    totalSelectionsBefore: rows.reduce((sum, row) => sum + row.selections.length, 0),
    teamsWithNeed: material.filter((row) => row.openStartingSlots > 0).length,
  };
}

const NEED_WEIGHT: Record<NeedLevel, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  none: 0,
};

/* ----------------------------------------------------------------- H. plan */

export function buildPlan(
  playerId: string,
  playerName: string,
  result: DraftRecommendationResult,
  brief: DraftBrief | null,
): NextPickPlanView | null {
  const internals = result.internals;
  if (!internals || !brief) return null;
  // "Take him now" is not a plan for somebody another team already took.
  if (!internals.candidatePool.some((candidate) => candidate.playerId === playerId)) {
    return null;
  }

  const steps: PlanStep[] = [];
  const currentPick = brief.draft.currentOverallPick;
  const nextPick = brief.draft.nextOurPick;
  const gap = brief.draft.picksUntilOurNextSelection;

  steps.push({
    kind: 'now',
    label: `Take ${playerName}`,
    detail: `Pick ${currentPick}, round ${brief.draft.currentRound}.`,
    overallPick: currentPick,
    position: internals.playerOf(playerId)?.position ?? null,
    expected: [],
  });

  if (nextPick === null || gap === null) return { steps, strategistPlan: null };

  steps.push({
    kind: 'gap',
    label: `${gap} ${gap === 1 ? 'selection' : 'selections'} by other teams`,
    detail:
      gap === 0
        ? 'You select again immediately.'
        : `${brief.room.teamsBeforeOurNextPick.length} teams pick before you do.`,
    overallPick: null,
    position: null,
    expected: [],
  });

  /*
   * What to target next: the position with the emptiest starting slot AFTER
   * this pick, taken from the same roster model the recommendation uses rather
   * than from a rule about rounds.
   */
  const takenPosition = internals.playerOf(playerId)?.position ?? null;
  const remainingNeeds = brief.ourTeam.needs
    .map((need) => ({
      ...need,
      openStartingSlots:
        need.position === takenPosition
          ? Math.max(0, need.openStartingSlots - 1)
          : need.openStartingSlots,
    }))
    .filter((need) => need.openStartingSlots > 0)
    .sort((a, b) => b.openStartingSlots - a.openStartingSlots);

  const outcomes = internals.roomOutcomes;
  const target = remainingNeeds[0] ?? null;
  const fallback = remainingNeeds[1] ?? null;

  const expectedAt = (position: Position | null) => {
    if (!outcomes || !position) return [];
    return likelyBestAvailable(outcomes, { limit: 3, position })
      .filter((entry) => entry.playerId !== playerId)
      .map((entry) => ({
        playerId: entry.playerId,
        name: internals.playerOf(entry.playerId)?.name ?? entry.playerId,
        frequency: entry.frequency,
      }));
  };

  steps.push({
    kind: 'target',
    label: target ? `Target ${target.position}` : 'Take the best available',
    detail: target
      ? `${target.openStartingSlots} starting ${target.openStartingSlots === 1 ? 'slot' : 'slots'} still open at ${target.position}.`
      : 'Every starting slot is filled, so the next pick is about depth.',
    overallPick: nextPick,
    position: target?.position ?? null,
    expected: expectedAt(target?.position ?? null),
  });

  if (fallback) {
    steps.push({
      kind: 'target',
      label: `Fall back to ${fallback.position}`,
      detail: `If ${target?.position ?? 'the target'} is gone, ${fallback.openStartingSlots} ${fallback.position} ${fallback.openStartingSlots === 1 ? 'slot is' : 'slots are'} still open.`,
      overallPick: nextPick,
      position: fallback.position,
      expected: expectedAt(fallback.position),
    });
  }

  for (const obligation of brief.constraints.mustFillBeforeDraftEnds) {
    if (obligation.position !== 'K' && obligation.position !== 'DEF') continue;
    steps.push({
      kind: 'obligation',
      label: `${obligation.count} ${obligation.position} still required`,
      detail: `${brief.constraints.endgame.spareSelections} of your remaining ${brief.constraints.endgame.ourSelectionsRemaining} selections are spare.`,
      overallPick: null,
      position: obligation.position,
      expected: [],
    });
  }

  return {
    steps,
    strategistPlan: null,
  };
}
