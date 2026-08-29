/**
 * Is the survival estimate any good?
 *
 * The strategist passed on Zay Flowers at pick 52 partly because Juancho put
 * Tyler Warren at 10.5% to survive to our next turn, and Warren was still on
 * the board seventeen selections later. That is one observation, and one
 * observation says almost nothing: a 10.5% event happens about one time in ten,
 * and a model that never produced surprising outcomes would be badly wrong in a
 * different way.
 *
 * The honest question is statistical. Across every historical decision in the
 * corpus, when the model said 30%, did roughly 30% of those players actually
 * survive? That is calibration, and it is measurable from data we already have:
 * the saved mocks record who was available at every one of our selections and
 * exactly who was taken afterwards.
 *
 * Nothing here changes the probability model. It measures it.
 */
import type { Position } from '../../players/types';
import type { DraftRoomRankingSnapshot, ProjectionSnapshot } from '../../data/types';
import type { CanonicalPlayerMap } from '../../players/types';
import type { SleeperDraft, SleeperLeague, SleeperRoster } from '../../sleeper/types';
import { buildBriefAtPick, ourPickNumbers } from './brief-replay';
import type { SurvivalModel } from '../draft/recommendations';
import type { RegressionCase } from './case';

export interface SurvivalObservation {
  draftId: string;
  /** The selection at which the prediction was made. */
  overallPick: number;
  round: number;
  playerId: string;
  playerName: string;
  position: Position;
  /** 0-100, as the engine reported it. */
  predicted: number;
  /** Whether he was still on the board at our next selection. */
  survived: boolean;
  /** Selections between the prediction and our next turn. */
  interveningPicks: number;
  /** Distinct teams ahead of us that still needed his position. */
  teamsNeedingPosition: number;
  /** True at the turn, where nobody picks in between and 100% is a certainty. */
  backToBack: boolean;
  firstSeedRank: number | null;
}

export interface CalibrationBucket {
  /** Inclusive lower bound, exclusive upper, in percent. */
  from: number;
  to: number;
  count: number;
  meanPredicted: number;
  actualSurvivalRate: number;
  /** Actual minus predicted. Positive means the model is under-confident. */
  gap: number;
}

export interface CalibrationSummary {
  label: string;
  count: number;
  /** Mean squared error between predicted probability and outcome. Lower is better. */
  brier: number;
  /**
   * The score a model that always predicts the base rate would get.
   *
   * Without it a Brier score is uninterpretable: 0.15 is excellent when events
   * are near-even and useless when 90% of them go one way.
   */
  baseRateBrier: number;
  /** How much of the base-rate error the model removes. Negative means harm. */
  skill: number;
  meanPredicted: number;
  actualSurvivalRate: number;
}

/**
 * A conservation check on one decision.
 *
 * At most one player leaves the board per selection. So across any set of
 * players, the number the model expects to be gone by our next turn cannot
 * exceed the number of selections that happen in between - it is not a
 * calibration preference, it is arithmetic. A model that violates it is not
 * mildly pessimistic; it is describing a draft that cannot occur.
 */
export interface RemovalBudget {
  draftId: string;
  overallPick: number;
  round: number;
  poolSize: number;
  /** Sum of (1 - survival) across the offered pool. */
  expectedRemovals: number;
  /** How many of the offered pool the room actually took. */
  actualRemovals: number;
  /** The hard ceiling: one player per intervening selection. */
  maxPossibleRemovals: number;
  /** Expected over the ceiling. Above 1 is impossible, not merely wrong. */
  overBudget: number;
}

export interface CalibrationReport {
  observations: SurvivalObservation[];
  overall: CalibrationSummary;
  /** The same, with the certain back-to-back cases removed. */
  predictiveOnly: CalibrationSummary;
  buckets: CalibrationBucket[];
  byPosition: CalibrationSummary[];
  byIntervening: CalibrationSummary[];
  removalBudgets: RemovalBudget[];
}

export interface CalibrationInput {
  regression: RegressionCase;
  projections: ProjectionSnapshot;
  roomRankings: DraftRoomRankingSnapshot | null;
  players: CanonicalPlayerMap;
  league: SleeperLeague;
  draft: SleeperDraft;
  rosters: SleeperRoster[];
  /** Which availability model produced the predictions being checked. */
  survivalModel?: SurvivalModel;
}

/**
 * Every prediction the engine made that we can check the outcome of.
 *
 * One row per available player per selection, excluding the player we actually
 * took - he was removed by us rather than by the room, so his survival was
 * never in question.
 */
export function collectSurvivalObservations(
  input: CalibrationInput,
): SurvivalObservation[] {
  const { regression } = input;
  const ordered = [...regression.picks].sort((a, b) => a.pick_no - b.pick_no);
  const ours = ourPickNumbers(regression);
  const observations: SurvivalObservation[] = [];

  for (let index = 0; index < ours.length - 1; index += 1) {
    const overallPick = ours[index];
    const nextPick = ours[index + 1];
    const brief = buildBriefAtPick(input, overallPick);
    if (!brief) continue;

    /*
     * Everyone the room removed between this selection and our next one.
     *
     * Strictly between: the pick at `overallPick` is ours, and the pick at
     * `nextPick` is the moment we are asking about - a player taken there has
     * by definition survived to it.
     */
    const takenBetween = new Set(
      ordered
        .filter((pick) => pick.pick_no > overallPick && pick.pick_no < nextPick)
        .map((pick) => input.players.bySleeperId.get(pick.player_id)?.id)
        .filter((playerId): playerId is string => Boolean(playerId)),
    );
    const takenByUs = input.players.bySleeperId.get(
      ordered.find((pick) => pick.pick_no === overallPick)?.player_id ?? '',
    )?.id;

    const interveningPicks = nextPick - overallPick - 1;

    for (const candidate of brief.candidates) {
      if (candidate.playerId === takenByUs) continue;
      const predicted = candidate.survival.probability;
      if (predicted === null) continue;

      observations.push({
        draftId: regression.draftId,
        overallPick,
        round: brief.draft.currentRound,
        playerId: candidate.playerId,
        playerName: candidate.name,
        position: candidate.position,
        predicted,
        survived: !takenBetween.has(candidate.playerId),
        interveningPicks,
        teamsNeedingPosition: candidate.survival.interveningTeamsWithNeed,
        backToBack: interveningPicks === 0,
        firstSeedRank: candidate.firstSeed.rank,
      });
    }
  }

  return observations;
}

export function buildCalibrationReport(
  observations: SurvivalObservation[],
): CalibrationReport {
  const predictive = observations.filter((entry) => !entry.backToBack);

  const buckets: CalibrationBucket[] = [];
  for (let from = 0; from < 100; from += 10) {
    const to = from + 10;
    // The last bucket is closed so a prediction of exactly 100 has a home.
    const inBucket = observations.filter(
      (entry) => entry.predicted >= from && (to === 100 ? entry.predicted <= to : entry.predicted < to),
    );
    if (inBucket.length === 0) {
      buckets.push({ from, to, count: 0, meanPredicted: 0, actualSurvivalRate: 0, gap: 0 });
      continue;
    }
    const meanPredicted = mean(inBucket.map((entry) => entry.predicted));
    const actual = rate(inBucket) * 100;
    buckets.push({
      from,
      to,
      count: inBucket.length,
      meanPredicted: round1(meanPredicted),
      actualSurvivalRate: round1(actual),
      gap: round1(actual - meanPredicted),
    });
  }

  const positions: Position[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
  const byPosition = positions
    .map((position) =>
      summarize(
        position,
        observations.filter((entry) => entry.position === position),
      ),
    )
    .filter((summary): summary is CalibrationSummary => summary !== null);

  const bands: [string, (n: number) => boolean][] = [
    ['0 (at the turn)', (n) => n === 0],
    ['1-4', (n) => n >= 1 && n <= 4],
    ['5-9', (n) => n >= 5 && n <= 9],
    ['10-15', (n) => n >= 10 && n <= 15],
    ['16+', (n) => n >= 16],
  ];
  const byIntervening = bands
    .map(([label, test]) =>
      summarize(label, observations.filter((entry) => test(entry.interveningPicks))),
    )
    .filter((summary): summary is CalibrationSummary => summary !== null);

  return {
    observations,
    removalBudgets: buildRemovalBudgets(observations),
    overall: summarize('all predictions', observations)!,
    predictiveOnly: summarize('excluding the turn', predictive)!,
    buckets,
    byPosition,
    byIntervening,
  };
}

/**
 * Groups predictions by the decision they were made at, and checks the budget.
 *
 * This is the diagnostic that explains a calibration curve rather than merely
 * describing it: independent per-player probabilities have nothing tying them
 * together, so nothing stops their sum from implying more removals than there
 * are picks.
 */
export function buildRemovalBudgets(observations: SurvivalObservation[]): RemovalBudget[] {
  const grouped = new Map<string, SurvivalObservation[]>();
  for (const entry of observations) {
    const key = `${entry.draftId}#${entry.overallPick}`;
    grouped.set(key, [...(grouped.get(key) ?? []), entry]);
  }

  return [...grouped.values()]
    .map((entries) => {
      const first = entries[0];
      const expectedRemovals = entries.reduce(
        (sum, entry) => sum + (100 - entry.predicted) / 100,
        0,
      );
      const maxPossibleRemovals = first.interveningPicks;
      return {
        draftId: first.draftId,
        overallPick: first.overallPick,
        round: first.round,
        poolSize: entries.length,
        expectedRemovals: round1(expectedRemovals),
        actualRemovals: entries.filter((entry) => !entry.survived).length,
        maxPossibleRemovals,
        overBudget:
          maxPossibleRemovals === 0
            ? 0
            : round3(expectedRemovals / maxPossibleRemovals),
      };
    })
    .sort((a, b) => a.draftId.localeCompare(b.draftId) || a.overallPick - b.overallPick);
}

function summarize(label: string, entries: SurvivalObservation[]): CalibrationSummary | null {
  if (entries.length === 0) return null;
  const base = rate(entries);
  const brier = mean(
    entries.map((entry) => (entry.predicted / 100 - (entry.survived ? 1 : 0)) ** 2),
  );
  /*
   * The reference is a model that ignores every input and always predicts how
   * often the event happens. Beating it is the minimum bar for the estimate
   * being worth computing at all.
   */
  const baseRateBrier = mean(entries.map((entry) => (base - (entry.survived ? 1 : 0)) ** 2));

  return {
    label,
    count: entries.length,
    brier: round4(brier),
    baseRateBrier: round4(baseRateBrier),
    skill: baseRateBrier === 0 ? 0 : round3(1 - brier / baseRateBrier),
    meanPredicted: round1(mean(entries.map((entry) => entry.predicted))),
    actualSurvivalRate: round1(base * 100),
  };
}

const mean = (values: number[]) =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
const rate = (entries: SurvivalObservation[]) =>
  entries.length === 0 ? 0 : entries.filter((entry) => entry.survived).length / entries.length;
const round1 = (value: number) => Math.round(value * 10) / 10;
const round3 = (value: number) => Math.round(value * 1000) / 1000;
const round4 = (value: number) => Math.round(value * 10000) / 10000;
