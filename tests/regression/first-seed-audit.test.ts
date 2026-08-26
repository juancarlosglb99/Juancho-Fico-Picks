/**
 * How far Juancho is allowed to stray from First Seed, checked on real drafts.
 *
 * First Seed's draft-room ranking is the prior. Deviating from it is allowed,
 * but it has to be earned: a league-specific reason the engine can name, and a
 * completed-roster simulation that actually improves. This prints the audit for
 * every saved mock and fails when the engine is inventing its own board.
 *
 *     npm run test:regression
 */
import { describe, expect, it } from 'vitest';
import {
  MATERIAL_PLAN_LOSS,
  MEANINGFUL_RANK_GAP,
  type DeviationRecord,
} from '../../packages/engine/benchmark/deviation';
import { listCases } from '../../packages/engine/benchmark/store';
import { replayCase } from './replay-harness';

const cases = listCases();

function line(entry: DeviationRecord): string {
  const fs = entry.firstSeedBest;
  const gap = entry.rankGap === null ? '  —' : String(entry.rankGap).padStart(3);
  const delta =
    entry.planDelta === null ? '    —' : `${entry.planDelta >= 0 ? '+' : ''}${entry.planDelta.toFixed(1)}`;
  const verdict =
    entry.reason === 'followed_first_seed'
      ? '='
      : entry.improved === true
        ? '✓'
        : entry.improved === false
          ? '✗'
          : '?';
  return (
    `R${String(entry.round).padStart(2)} p${String(entry.overallPick).padStart(3)} │ ` +
    `FS#${String(fs?.firstSeedRank ?? '—').padStart(3)} ${(fs?.name ?? '—').slice(0, 20).padEnd(20)} │ ` +
    `FS#${String(entry.juancho.firstSeedRank ?? '—').padStart(3)} ${entry.juancho.name.slice(0, 20).padEnd(20)} │ ` +
    `gap ${gap} │ plan ${delta.padStart(7)} ${verdict} │ ${entry.reason}`
  );
}

describe('deviation from First Seed', () => {
  it.each(cases.map((entry) => ({ entry, name: entry.draftId })))(
    'audits $name',
    ({ entry }) => {
      const result = replayCase(entry);
      const summary = result.deviationSummary;

      console.log(
        `\n[audit] ${entry.draftId} · seat ${entry.userSlot} · ${entry.format.teams}-team ` +
          `${entry.format.scoringProfile} ${entry.format.qbFormat}`,
      );
      console.log(
        `        ${'First Seed best available'.padEnd(26)}   ${'Juancho #1'.padEnd(26)}`,
      );
      for (const record of result.deviations) console.log(`  ${line(record)}`);
      console.log(
        `[audit] followed ${summary.followed}/${summary.picks} · deviations ${summary.deviations} ` +
          `(${summary.meaningfulDeviations} beyond ${MEANINGFUL_RANK_GAP} ranks) · ` +
          `justified ${summary.justified} · unjustified ${summary.unjustified} · ` +
          `plan improved ${summary.improvedPlan} / worsened ${summary.worsenedPlan} · ` +
          `net ${summary.netPlanDelta >= 0 ? '+' : ''}${summary.netPlanDelta} pts`,
      );
      console.log(`[audit] reasons: ${JSON.stringify(summary.byReason)}`);

      /* ----------------------------------------------------- the rules */

      // Every MEANINGFUL deviation must name a league-specific reason. Choosing
      // between two players First Seed rates within a few spots of each other is
      // not deference worth arguing about, and demanding a story for it would
      // just produce stories.
      const unjustified = result.deviations.filter(
        (record) =>
          record.reason === 'unjustified' && (record.rankGap ?? 0) >= MEANINGFUL_RANK_GAP,
      );
      expect(
        unjustified.map((record) => `p${record.overallPick} ${record.juancho.name}`),
      ).toEqual([]);

      // A deviation that materially worsens the completed roster is never
      // acceptable, whatever story can be told about it. The threshold exists
      // because the plan is a greedy completion and wobbles by a point or two
      // for reasons that have nothing to do with the pick.
      const harmful = result.deviations.filter(
        (record) => (record.planDelta ?? 0) < -MATERIAL_PLAN_LOSS,
      );
      expect(
        harmful.map(
          (record) =>
            `p${record.overallPick} took ${record.juancho.name} over ${record.firstSeedBest?.name} for ${record.planDelta} plan points`,
        ),
      ).toEqual([]);

      // Passing over a player First Seed rates far higher demands a real reason,
      // not merely a technically-true one.
      for (const record of result.deviations) {
        if ((record.rankGap ?? 0) < MEANINGFUL_RANK_GAP) continue;
        expect(
          [
            'positional_saturation',
            'starter_need',
            'tier_cliff',
            'returns_to_us',
            'opportunity_cost',
            'higher_projection',
          ],
          `pick ${record.overallPick}: ${record.explanation}`,
        ).toContain(record.reason);
      }

      // And the engine must at least consider First Seed's best available.
      const ignored = result.deviations.filter(
        (record) => record.firstSeedBest === null && record.reason === 'unjustified',
      );
      expect(ignored.map((record) => record.overallPick)).toEqual([]);
    },
  );
});
