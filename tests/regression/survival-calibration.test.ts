/**
 * How well calibrated is the survival estimate?
 *
 *     npm run calibration
 *
 * Every recommendation the engine makes leans on "will he still be there next
 * turn", and until now that number had never been checked against what actually
 * happened. The corpus makes it checkable: it records who was available at each
 * of our selections and exactly who the room took afterwards.
 *
 * This measures and reports. It asserts almost nothing on purpose - the point
 * is to see the numbers before deciding whether the model needs changing.
 */
import { describe, expect, it } from 'vitest';
import {
  buildCalibrationReport,
  collectSurvivalObservations,
  type CalibrationSummary,
  type SurvivalObservation,
} from '../../packages/engine/benchmark/survival-calibration';
import {
  listCases,
  readProjectionSnapshot,
  readRoomSnapshot,
} from '../../packages/engine/benchmark/store';
import { buildDraftAttachment } from '../../packages/sleeper/attachment';
import { draftFor, playersFor } from './replay-harness';

const cases = listCases();

function inputFor(entry: (typeof cases)[number]) {
  const draft = draftFor(entry);
  const attachment = buildDraftAttachment({ draft, league: null, rosters: null });
  return {
    regression: entry,
    projections: readProjectionSnapshot(entry.projectionsRef),
    roomRankings: entry.roomRankingsRef ? readRoomSnapshot(entry.roomRankingsRef) : null,
    players: playersFor(entry),
    league: attachment.league,
    draft,
    rosters: attachment.rosters,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function summaryLine(summary: CalibrationSummary): string {
  return (
    `  ${summary.label.padEnd(18)} n=${String(summary.count).padStart(5)}  ` +
    `predicted ${summary.meanPredicted.toFixed(1).padStart(5)}%  ` +
    `actual ${summary.actualSurvivalRate.toFixed(1).padStart(5)}%  ` +
    `brier ${summary.brier.toFixed(4)}  ` +
    `base ${summary.baseRateBrier.toFixed(4)}  ` +
    `skill ${summary.skill >= 0 ? '+' : ''}${summary.skill.toFixed(3)}`
  );
}

describe('survival probability calibration', () => {
  it('measures the estimate against what actually happened', () => {
    const observations: SurvivalObservation[] = cases.flatMap((entry) =>
      collectSurvivalObservations(inputFor(entry)),
    );
    expect(observations.length, 'the corpus should yield predictions to check').toBeGreaterThan(100);

    const report = buildCalibrationReport(observations);

    console.log(
      `\n[calibration] ${observations.length} predictions from ${cases.length} saved mocks\n`,
    );

    console.log('OVERALL');
    console.log(summaryLine(report.overall));
    console.log(summaryLine(report.predictiveOnly));
    console.log(
      '  (skill is 1 - brier/base: positive means the estimate beats always guessing the base rate)',
    );

    console.log('\nCALIBRATION BUCKETS');
    console.log(
      '  bucket        n      mean predicted   actual survived    gap   verdict',
    );
    for (const bucket of report.buckets) {
      if (bucket.count === 0) {
        console.log(`  ${`${bucket.from}-${bucket.to}%`.padEnd(10)} ${'0'.padStart(5)}       —                —              —`);
        continue;
      }
      // A model is over-confident when it predicts a player will be gone more
      // often than he actually is - the direction that makes a pick feel urgent
      // when it is not.
      const verdict =
        Math.abs(bucket.gap) < 5
          ? 'well calibrated'
          : bucket.gap > 0
            ? 'UNDER-confident (survives more than predicted)'
            : 'OVER-confident (survives less than predicted)';
      console.log(
        `  ${`${bucket.from}-${bucket.to}%`.padEnd(10)} ${String(bucket.count).padStart(5)}  ` +
          `${bucket.meanPredicted.toFixed(1).padStart(13)}%  ` +
          `${bucket.actualSurvivalRate.toFixed(1).padStart(14)}%  ` +
          `${(bucket.gap >= 0 ? '+' : '') + bucket.gap.toFixed(1)}`.padStart(8) +
          `   ${verdict}`,
      );
    }

    console.log('\nBY POSITION');
    for (const summary of report.byPosition) console.log(summaryLine(summary));

    console.log('\nBY INTERVENING SELECTIONS');
    for (const summary of report.byIntervening) console.log(summaryLine(summary));

    /*
     * The check that explains the curve rather than just describing it.
     *
     * At most one player leaves the board per selection, so the expected number
     * gone can never exceed the number of intervening picks. This is arithmetic,
     * not a preference.
     */
    console.log('\nREMOVAL BUDGET (expected departures vs how many picks actually happen)');
    console.log('  decision              pool   model expects gone   actually gone   ceiling   over');
    const budgets = report.removalBudgets.filter((entry) => entry.maxPossibleRemovals > 0);
    for (const budget of budgets.slice(0, 12)) {
      console.log(
        `  ${budget.draftId.slice(-6)} R${String(budget.round).padStart(2)} p${String(budget.overallPick).padStart(3)}  ` +
          `${String(budget.poolSize).padStart(5)}  ${budget.expectedRemovals.toFixed(1).padStart(17)}  ` +
          `${String(budget.actualRemovals).padStart(14)}  ${String(budget.maxPossibleRemovals).padStart(8)}  ` +
          `${budget.overBudget.toFixed(2).padStart(5)}x`,
      );
    }
    const over = budgets.filter((entry) => entry.overBudget > 1);
    console.log(
      `  → ${over.length} of ${budgets.length} decisions expect MORE departures than there are picks; ` +
        `worst ${Math.max(...budgets.map((entry) => entry.overBudget)).toFixed(2)}x, ` +
        `median ${median(budgets.map((entry) => entry.overBudget)).toFixed(2)}x`,
    );

    /*
     * The observation that prompted this, shown as ONE data point and not as
     * proof of anything. A 10.5% event occurring is not evidence of a broken
     * model; the buckets above are where the answer actually lives.
     */
    const warren = observations.find(
      (entry) =>
        entry.draftId === '1398448522730221568' &&
        entry.overallPick === 52 &&
        entry.playerName.includes('Tyler Warren'),
    );
    console.log('\nTHE OBSERVATION THAT PROMPTED THIS (one data point, not a verdict)');
    if (warren) {
      console.log(
        `  ${warren.playerName} (${warren.position}) at pick ${warren.overallPick}: ` +
          `predicted ${warren.predicted}% to survive ${warren.interveningPicks} intervening ` +
          `selections with ${warren.teamsNeedingPosition} teams ahead needing ${warren.position} — ` +
          `actually ${warren.survived ? 'SURVIVED' : 'was taken'}`,
      );
      const peers = observations.filter(
        (entry) => Math.abs(entry.predicted - warren.predicted) <= 5,
      );
      console.log(
        `  peers within 5 points of that estimate: ${peers.length} predictions, ` +
          `${peers.filter((entry) => entry.survived).length} survived ` +
          `(${((peers.filter((entry) => entry.survived).length / peers.length) * 100).toFixed(1)}% ` +
          `against a predicted ${warren.predicted}%)`,
      );
    } else {
      console.log('  not found in the corpus');
    }

    expect(warren, 'Tyler Warren at pick 52 should be one of the observations').toBeTruthy();
    expect(warren!.survived).toBe(true);
  });

  it('counts an outcome as survival only if the room did not take him', () => {
    // A sanity check on the measurement itself, which is the part most likely
    // to be quietly wrong: at the turn nobody picks in between, so everybody
    // must survive and the engine's certain 100% must be exactly right.
    const observations = cases.flatMap((entry) => collectSurvivalObservations(inputFor(entry)));
    const atTheTurn = observations.filter((entry) => entry.backToBack);
    if (atTheTurn.length === 0) return;
    expect(atTheTurn.every((entry) => entry.survived)).toBe(true);
    expect(atTheTurn.every((entry) => entry.predicted === 100)).toBe(true);
  });
});
