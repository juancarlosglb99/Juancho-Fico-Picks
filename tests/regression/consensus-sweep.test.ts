/**
 * Reports Juancho against the First Seed-only baseline at the current anchor
 * weight. Driven by `npm run tune:consensus`, which runs it once per weight.
 */
import { describe, expect, it } from 'vitest';
import { draftByFirstSeedOnly } from '../../packages/engine/benchmark/first-seed-baseline';
import { listCases, readProjectionSnapshot, readRoomSnapshot } from '../../packages/engine/benchmark/store';
import { draftFor, playersFor, replayCase } from './replay-harness';
import { buildDraftAttachment } from '../../packages/sleeper/attachment';

describe('sweep', () => {
  it('reports quality at the current anchor weight', () => {
    const weight = process.env.JUANCHO_CONSENSUS_WEIGHT ?? 'default';
    const cases = listCases();
    expect(cases.length).toBeGreaterThan(0);
    for (const entry of cases) {
      const players = playersFor(entry);
      const draft = draftFor(entry);
      const attachment = buildDraftAttachment({ draft, league: null, rosters: null });
      const baseline = draftByFirstSeedOnly({
        regression: entry,
        projections: readProjectionSnapshot(entry.projectionsRef),
        roomRankings: entry.roomRankingsRef ? readRoomSnapshot(entry.roomRankingsRef) : null,
        players, league: attachment.league, draft, rosters: attachment.rosters,
      });
      const r = replayCase(entry);
      const j = r.quality.roster;
      const d = r.deviationSummary;
      console.log(
        `[sweep w=${String(weight).padStart(4)}] ${entry.draftId.slice(-6)} ` +
        `juancho=${j.startingValue.toFixed(1).padStart(7)} firstseed=${baseline.quality.startingValue.toFixed(1).padStart(7)} ` +
        `delta=${(j.startingValue - baseline.quality.startingValue).toFixed(1).padStart(7)} ` +
        `followed=${d.followed}/${d.picks} unjust=${d.unjustified} worsened=${d.worsenedPlan}`,
      );
    }
  });
});
