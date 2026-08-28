/**
 * The answer first, the evidence second.
 *
 * A comparison drawer that opens with seven rows of metrics has asked the
 * drafter to be the engine. He has forty seconds and he already has an engine.
 * So this states which player it should be, why, and the conditions under which
 * the other one is the right call - and the table goes underneath.
 *
 * Nothing here is a second opinion. The verdict IS the engine's ordering; every
 * sentence is licensed by a quantity the engine computed, and where the engine
 * has no view - two players it never shortlisted - this says so rather than
 * inventing one.
 */
import type { PlayerAnalysis } from './player-analysis';
import { describeEdge, type EdgeStrength } from './plain-language';

export interface CompareCase {
  playerId: string;
  name: string;
  /** "you want the strongest starting lineup right now" */
  when: string;
}

export interface CompareVerdict {
  winnerId: string;
  /** "Jordan Addison is the better fit for your roster." */
  summary: string;
  /** Two or three sentences. Each one cites something specific. */
  reasons: string[];
  cases: CompareCase[];
  edge: EdgeStrength;
  /** Set when the engine has no opinion, so the summary must not imply one. */
  caveat: string | null;
}

export function buildCompareVerdict(
  analyses: PlayerAnalysis[],
): CompareVerdict | null {
  if (analyses.length < 2) return null;

  const ranked = [...analyses].sort(
    (a, b) => rankOf(a) - rankOf(b) || projectionOf(b) - projectionOf(a),
  );
  const [winner, runnerUp] = ranked;
  const noOpinion = winner.header.engineRank === null;

  const winnerGain = winner.replacement?.subject.rosterGain ?? null;
  const runnerUpGain = runnerUp.replacement?.subject.rosterGain ?? null;
  const gainDifference =
    winnerGain !== null && runnerUpGain !== null ? winnerGain - runnerUpGain : null;

  const edge: EdgeStrength =
    gainDifference !== null
      ? describeEdge(gainDifference)
      : edgeFromRanks(winner, runnerUp);

  const reasons = buildReasons(winner, runnerUp, gainDifference);
  if (edge === 'slight') {
    // Saying "slight edge" and then arguing for three sentences invites the
    // reader to think it is closer to a verdict than it is.
    reasons.push('There is little between them - either is a defensible pick.');
  }

  return {
    winnerId: winner.header.playerId,
    summary: noOpinion
      ? `${winner.header.name} is the higher-projected of the two.`
      : `${winner.header.name} is the better fit for your roster.`,
    reasons,
    cases: [buildCase(winner, runnerUp, true), buildCase(runnerUp, winner, false)],
    edge,
    caveat: noOpinion
      ? 'Neither player is on the engine’s shortlist for this pick, so this compares them on projection alone.'
      : null,
  };
}

function rankOf(analysis: PlayerAnalysis): number {
  return analysis.header.engineRank ?? Number.MAX_SAFE_INTEGER;
}

function projectionOf(analysis: PlayerAnalysis): number {
  return analysis.header.leagueProjection ?? 0;
}

/**
 * Up to three sentences, each about one real difference.
 *
 * Ordered by what a drafter decides on: what the pick does for the lineup, then
 * what it does for the bench, then whether the timing forces the issue.
 */
function buildReasons(
  winner: PlayerAnalysis,
  runnerUp: PlayerAnalysis,
  gainDifference: number | null,
): string[] {
  const reasons: string[] = [];

  const winnerNeeds = (winner.need?.openStartingSlots ?? 0) >= 0.5;
  const runnerUpNeeds = (runnerUp.need?.openStartingSlots ?? 0) >= 0.5;
  if (winnerNeeds && !runnerUpNeeds) {
    reasons.push(
      `${winner.header.name} fills a starting spot you still have open at ${winner.header.position}; ${runnerUp.header.name} would be bench depth.`,
    );
  } else if (!winnerNeeds && !runnerUpNeeds) {
    reasons.push(
      'Both would be bench depth - every starting spot either could fill is already taken.',
    );
  }

  if (gainDifference !== null && Math.abs(gainDifference) >= 1) {
    reasons.push(
      `He adds about ${Math.abs(Math.round(gainDifference))} more points to your roster right now.`,
    );
  } else if (winner.header.leagueProjection !== null && runnerUp.header.leagueProjection !== null) {
    const gap = Math.round(winner.header.leagueProjection - runnerUp.header.leagueProjection);
    if (Math.abs(gap) >= 5) {
      reasons.push(
        gap > 0
          ? `He is projected about ${gap} points higher over the season.`
          : `${runnerUp.header.name} projects about ${Math.abs(gap)} points higher, but the engine still prefers ${winner.header.name} for how he fits.`,
      );
    }
  }

  const winnerSurvival = winner.survival?.probability ?? null;
  const runnerUpSurvival = runnerUp.survival?.probability ?? null;
  if (
    winnerSurvival !== null &&
    runnerUpSurvival !== null &&
    runnerUpSurvival - winnerSurvival >= 12
  ) {
    /*
     * The sequencing argument, which is the one drafters most often get wrong:
     * taking the player who will still be there is how you end up with neither.
     */
    reasons.push(
      `${runnerUp.header.name} is ${Math.round(runnerUpSurvival)}% to still be available at your next pick against ${Math.round(winnerSurvival)}% for ${winner.header.name}, so taking ${winner.header.name} first is the better order.`,
    );
  }

  return reasons.slice(0, 2);
}

function buildCase(
  subject: PlayerAnalysis,
  other: PlayerAnalysis,
  isWinner: boolean,
): CompareCase {
  const survival = subject.survival?.probability ?? null;
  const otherSurvival = other.survival?.probability ?? null;
  const differentPosition = subject.header.position !== other.header.position;
  const needsHim = (subject.need?.openStartingSlots ?? 0) >= 0.5;

  const when = isWinner
    ? needsHim
      ? 'you want to fill a starting spot now'
      : 'you want the strongest roster the engine can see'
    : differentPosition
      ? `you prefer ${subject.header.position} depth`
      : survival !== null && otherSurvival !== null && survival < otherSurvival
        ? 'you think he is the one who will not last'
        : 'you rate him higher than the consensus does';

  return { playerId: subject.header.playerId, name: subject.header.name, when };
}

/** With no roster-value figure to compare, distance on the board is what is left. */
function edgeFromRanks(winner: PlayerAnalysis, runnerUp: PlayerAnalysis): EdgeStrength {
  const a = winner.header.engineRank;
  const b = runnerUp.header.engineRank;
  if (a === null || b === null) return 'slight';
  const distance = Math.abs(b - a);
  if (distance >= 5) return 'strong';
  if (distance >= 2) return 'moderate';
  return 'slight';
}
