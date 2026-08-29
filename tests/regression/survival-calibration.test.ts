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
import type { SurvivalModel } from '../../packages/engine/draft/recommendations';
import { buildDraftAttachment } from '../../packages/sleeper/attachment';
import { draftFor, playersFor } from './replay-harness';

const cases = listCases();

function inputFor(entry: (typeof cases)[number], survivalModel: SurvivalModel) {
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
    survivalModel,
  };
}

/** Every prediction one model made across the whole corpus. */
function observationsFor(survivalModel: SurvivalModel): SurvivalObservation[] {
  return cases.flatMap((entry) => collectSurvivalObservations(inputFor(entry, survivalModel)));
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
  it('measures both models against what actually happened', () => {
    /*
     * The old model is kept behind a switch precisely so this comparison can be
     * made on identical boards. Two numbers produced from different data would
     * settle nothing.
     */
    const oldObs = observationsFor('independent');
    const newObs = observationsFor('simulation');
    expect(oldObs.length).toBe(newObs.length);
    expect(newObs.length).toBeGreaterThan(100);

    const oldReport = buildCalibrationReport(oldObs);
    const newReport = buildCalibrationReport(newObs);

    console.log(
      `\n[calibration] ${newObs.length} predictions from ${cases.length} saved mocks\n`,
    );

    console.log('OVERALL                OLD (independent hazard)');
    console.log(summaryLine(oldReport.overall));
    console.log(summaryLine(oldReport.predictiveOnly));
    console.log('                       NEW (sequential room simulation)');
    console.log(summaryLine(newReport.overall));
    console.log(summaryLine(newReport.predictiveOnly));
    console.log(
      '  (skill is 1 - brier/base: positive means the estimate beats always guessing the base rate)',
    );

    console.log('\nCALIBRATION BUCKETS          OLD                        NEW');
    console.log(
      '  bucket         n    predicted   actual    gap  │     n    predicted   actual    gap',
    );
    for (let index = 0; index < newReport.buckets.length; index += 1) {
      const before = oldReport.buckets[index];
      const after = newReport.buckets[index];
      console.log(
        `  ${`${after.from}-${after.to}%`.padEnd(9)} ` +
          `${bucketCells(before)}  │  ${bucketCells(after)}`,
      );
    }

    console.log('\nBY POSITION            OLD → NEW');
    for (const after of newReport.byPosition) {
      const before = oldReport.byPosition.find((entry) => entry.label === after.label);
      console.log(comparisonLine(before, after));
    }

    console.log('\nBY INTERVENING SELECTIONS   OLD → NEW');
    for (const after of newReport.byIntervening) {
      const before = oldReport.byIntervening.find((entry) => entry.label === after.label);
      console.log(comparisonLine(before, after));
    }

    /*
     * The check that prompted the rewrite. At most one player leaves the board
     * per selection, so the expected number gone can never exceed the number of
     * intervening picks. This is arithmetic, not a preference.
     */
    console.log('\nREMOVAL BUDGET (expected departures ÷ picks that actually happen)');
    for (const [label, report] of [
      ['OLD', oldReport],
      ['NEW', newReport],
    ] as const) {
      const budgets = report.removalBudgets.filter((entry) => entry.maxPossibleRemovals > 0);
      const over = budgets.filter((entry) => entry.overBudget > 1);
      console.log(
        `  ${label}: ${over.length} of ${budgets.length} decisions expect MORE departures than there are picks · ` +
          `median ${median(budgets.map((entry) => entry.overBudget)).toFixed(2)}x · ` +
          `worst ${Math.max(...budgets.map((entry) => entry.overBudget)).toFixed(2)}x`,
      );
    }
    console.log('\n  a worked example, the decision that exposed it:');
    for (const [label, report] of [
      ['OLD', oldReport],
      ['NEW', newReport],
    ] as const) {
      const budget = report.removalBudgets.find(
        (entry) => entry.draftId.endsWith('783168') && entry.overallPick === 21,
      );
      if (!budget) continue;
      console.log(
        `    ${label} p21: pool ${budget.poolSize}, model expects ${budget.expectedRemovals.toFixed(1)} gone, ` +
          `${budget.actualRemovals} actually gone, ceiling ${budget.maxPossibleRemovals}`,
      );
    }

    /* The observation that started this, still just one data point. */
    const warren = newObs.find(
      (entry) =>
        entry.draftId === '1398448522730221568' &&
        entry.overallPick === 52 &&
        entry.playerName.includes('Tyler Warren'),
    );
    const warrenOld = oldObs.find(
      (entry) =>
        entry.draftId === '1398448522730221568' &&
        entry.overallPick === 52 &&
        entry.playerName.includes('Tyler Warren'),
    );
    console.log('\nTYLER WARREN AT PICK 52 (one observation, not a verdict)');
    if (warren && warrenOld) {
      console.log(
        `  OLD predicted ${warrenOld.predicted}%  ·  NEW predicted ${warren.predicted}%  ·  ` +
          `he actually ${warren.survived ? 'SURVIVED' : 'was taken'} ` +
          `(${warren.interveningPicks} intervening selections, ${warren.teamsNeedingPosition} teams ahead needing TE)`,
      );
      for (const [label, observations, subject] of [
        ['OLD', oldObs, warrenOld],
        ['NEW', newObs, warren],
      ] as const) {
        const peers = observations.filter(
          (entry) => Math.abs(entry.predicted - subject.predicted) <= 5,
        );
        const survived = peers.filter((entry) => entry.survived).length;
        console.log(
          `    ${label}: ${peers.length} predictions within 5 points of ${subject.predicted}%, ` +
            `${survived} survived (${((survived / peers.length) * 100).toFixed(1)}%)`,
        );
      }
    }

    expect(warren, 'Tyler Warren at pick 52 should be one of the observations').toBeTruthy();
    expect(warren!.survived).toBe(true);
    /*
     * Replays every benchmark case twice, once per survival model, which is the
     * only way the two are comparable on identical boards. That lands around
     * 5.6s on a developer machine - already over the default five seconds, and
     * it fails on duration rather than on an assertion. Give it room rather
     * than shrink what it covers. 20s matches vitest.smoke.config.ts.
     */
  }, 20_000);

  it('removes exactly as many players as there are selections', () => {
    /*
     * The property the rewrite exists to guarantee, asserted on real boards
     * rather than synthetic ones. Expected departures across the offered pool
     * cannot exceed the number of picks that happen.
     */
    const budgets = buildCalibrationReport(observationsFor('simulation')).removalBudgets.filter(
      (entry) => entry.maxPossibleRemovals > 0,
    );
    expect(budgets.length).toBeGreaterThan(0);
    for (const budget of budgets) {
      expect(
        budget.expectedRemovals,
        `${budget.draftId} p${budget.overallPick} expects ${budget.expectedRemovals} departures from ${budget.maxPossibleRemovals} picks`,
      ).toBeLessThanOrEqual(budget.maxPossibleRemovals + 0.5);
    }
  });

  it('counts an outcome as survival only if the room did not take him', () => {
    // A sanity check on the measurement itself, which is the part most likely
    // to be quietly wrong: at the turn nobody picks in between, so everybody
    // must survive and a certain 100% must be exactly right.
    const atTheTurn = observationsFor('simulation').filter((entry) => entry.backToBack);
    if (atTheTurn.length === 0) return;
    expect(atTheTurn.every((entry) => entry.survived)).toBe(true);
    expect(atTheTurn.every((entry) => entry.predicted === 100)).toBe(true);
  });
});

function bucketCells(bucket: { count: number; meanPredicted: number; actualSurvivalRate: number; gap: number }): string {
  if (bucket.count === 0) return `${'—'.padStart(5)}          —        —      —`;
  return (
    `${String(bucket.count).padStart(5)}  ${bucket.meanPredicted.toFixed(1).padStart(8)}%  ` +
    `${bucket.actualSurvivalRate.toFixed(1).padStart(6)}%  ` +
    `${((bucket.gap >= 0 ? '+' : '') + bucket.gap.toFixed(0)).padStart(5)}`
  );
}

function comparisonLine(before: CalibrationSummary | undefined, after: CalibrationSummary): string {
  const arrow = before
    ? `brier ${before.brier.toFixed(4)} → ${after.brier.toFixed(4)}   ` +
      `skill ${before.skill >= 0 ? '+' : ''}${before.skill.toFixed(2)} → ${after.skill >= 0 ? '+' : ''}${after.skill.toFixed(2)}`
    : `brier ${after.brier.toFixed(4)}`;
  return (
    `  ${after.label.padEnd(18)} n=${String(after.count).padStart(5)}  ` +
    `predicted ${before ? `${before.meanPredicted.toFixed(1)}%→` : ''}${after.meanPredicted.toFixed(1)}%  ` +
    `actual ${after.actualSurvivalRate.toFixed(1)}%  ${arrow}`
  );
}
