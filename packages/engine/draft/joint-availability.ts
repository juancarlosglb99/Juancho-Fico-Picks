/**
 * Questions about two players at once, answered by counting simulated futures.
 *
 * The strategist was given each candidate's chance of surviving to our next
 * turn and nothing else, and it did what anyone would do with marginals: it
 * reasoned about them jointly anyway. At pick 52 it argued that "two TEs cannot
 * both survive sixteen selections" from Warren at 10% and Kraft at 72% - a
 * claim about their joint distribution, made from numbers that do not contain
 * one.
 *
 * Multiplying the marginals would not fix it, because the events are strongly
 * coupled in both directions: a room that spends a pick on Warren has one fewer
 * pick left for Kraft, which makes Kraft SAFER, while a room hungry enough for
 * tight ends to take Warren early is a room likely to take Kraft too. Which
 * effect dominates is exactly what the simulation already works out.
 *
 * So nothing is modelled here. Every figure is a count over the same 300 runs
 * that produced the marginals, which means the joint numbers and the individual
 * ones can never disagree.
 */
import type { Position } from '../../players/types';
import type { RoomOutcomes } from './room-simulation';

export interface JointOutcome {
  /** 0-100, each measured over the same runs. */
  aSurvives: number;
  bSurvives: number;
  bothSurvive: number;
  atLeastOneSurvives: number;
  neitherSurvives: number;
  /**
   * The question a fallback plan actually turns on: if we lose A, do we still
   * get B? Null when A survived in every run, leaving nothing to condition on.
   */
  bSurvivesGivenAGone: number | null;
}

/** Both players must have been simulated; unknown ids return null. */
export function jointOutcome(
  outcomes: RoomOutcomes,
  aPlayerId: string,
  bPlayerId: string,
): JointOutcome | null {
  const a = outcomes.survivalByRun.get(aPlayerId);
  const b = outcomes.survivalByRun.get(bPlayerId);
  if (!a || !b || outcomes.runs === 0) return null;

  let aAlive = 0;
  let bAlive = 0;
  let both = 0;
  let neither = 0;
  let aGone = 0;
  let bAliveWhenAGone = 0;

  for (let run = 0; run < outcomes.runs; run += 1) {
    const aSurvived = a[run] === 1;
    const bSurvived = b[run] === 1;
    if (aSurvived) aAlive += 1;
    else aGone += 1;
    if (bSurvived) bAlive += 1;
    if (aSurvived && bSurvived) both += 1;
    if (!aSurvived && !bSurvived) neither += 1;
    if (!aSurvived && bSurvived) bAliveWhenAGone += 1;
  }

  const share = (count: number) => round1((count / outcomes.runs) * 100);
  return {
    aSurvives: share(aAlive),
    bSurvives: share(bAlive),
    bothSurvive: share(both),
    // Counted, not derived: a + b - both would give the same answer here, but
    // computing it independently means a bug shows up as a contradiction.
    atLeastOneSurvives: share(outcomes.runs - neither),
    neitherSurvives: share(neither),
    bSurvivesGivenAGone: aGone === 0 ? null : round1((bAliveWhenAGone / aGone) * 100),
  };
}

/**
 * The chance at least one of a group is still there.
 *
 * What "does this tier hold up?" really asks. A tier of two at 10% and 72% is a
 * completely different proposition from one player at 82%, and only the runs
 * can tell them apart.
 */
export function groupSurvival(
  outcomes: RoomOutcomes,
  playerIds: string[],
): { atLeastOne: number; expectedSurvivors: number; allSurvive: number } | null {
  const vectors = playerIds
    .map((playerId) => outcomes.survivalByRun.get(playerId))
    .filter((vector): vector is Uint8Array => Boolean(vector));
  if (vectors.length === 0 || outcomes.runs === 0) return null;

  let anyRuns = 0;
  let allRuns = 0;
  let survivorTotal = 0;
  for (let run = 0; run < outcomes.runs; run += 1) {
    let alive = 0;
    for (const vector of vectors) if (vector[run] === 1) alive += 1;
    survivorTotal += alive;
    if (alive > 0) anyRuns += 1;
    if (alive === vectors.length) allRuns += 1;
  }
  return {
    atLeastOne: round1((anyRuns / outcomes.runs) * 100),
    expectedSurvivors: round1(survivorTotal / outcomes.runs),
    allSurvive: round1((allRuns / outcomes.runs) * 100),
  };
}

export interface BestAvailableFrequency {
  playerId: string;
  /** How often he was the best-ranked player left at our next selection. */
  frequency: number;
}

/**
 * Who is most often the best name on the board when our turn comes round.
 *
 * A survival probability says whether one player reaches us. This says what the
 * board is actually likely to LOOK like, which is the thing a plan for the next
 * pick depends on.
 */
export function likelyBestAvailable(
  outcomes: RoomOutcomes,
  { limit = 5, position }: { limit?: number; position?: Position } = {},
): BestAvailableFrequency[] {
  const source = position
    ? outcomes.bestAvailableByPositionByRun.get(position)
    : outcomes.bestAvailableByRun;
  if (!source || outcomes.runs === 0) return [];

  const counts = new Map<string, number>();
  for (const playerId of source) {
    if (playerId === null) continue;
    counts.set(playerId, (counts.get(playerId) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.max(0, limit))
    .map(([playerId, count]) => ({
      playerId,
      frequency: round1((count / outcomes.runs) * 100),
    }));
}

const round1 = (value: number) => Math.round(value * 10) / 10;
