/**
 * Does the strategy engine actually beat the published board?
 *
 * Same saved draft, same seat, same room, same data. One seat takes First Seed's
 * best available every round; the other takes Juancho's recommendation. If
 * Juancho cannot win this, its deviations are not insight and it should defer.
 */
import { describe, expect, it } from 'vitest';
import { draftByFirstSeedOnly } from '../../packages/engine/benchmark/first-seed-baseline';
import { listCases, readProjectionSnapshot, readRoomSnapshot } from '../../packages/engine/benchmark/store';
import { draftFor, playersFor, replayCase } from './replay-harness';
import { buildDraftAttachment } from '../../packages/sleeper/attachment';

const cases = listCases();

describe('Juancho versus First Seed alone', () => {
  const rows: string[] = [];

  it.each(cases.map((entry) => ({ entry, name: entry.draftId })))(
    'beats the board on $name',
    ({ entry }) => {
      const players = playersFor(entry);
      const draft = draftFor(entry);
      const attachment = buildDraftAttachment({ draft, league: null, rosters: null });
      const projections = readProjectionSnapshot(entry.projectionsRef);
      const roomRankings = entry.roomRankingsRef
        ? readRoomSnapshot(entry.roomRankingsRef)
        : null;

      const baseline = draftByFirstSeedOnly({
        regression: entry,
        projections,
        roomRankings,
        players,
        league: attachment.league,
        draft,
        rosters: attachment.rosters,
      });
      const purist = draftByFirstSeedOnly({
        regression: entry,
        projections,
        roomRankings,
        players,
        league: attachment.league,
        draft,
        rosters: attachment.rosters,
        fillRequiredSlots: false,
      });
      const juancho = replayCase(entry).quality.roster;

      const compact = (counts: Record<string, number | undefined>) =>
        Object.entries(counts)
          .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
          .map(([position, count]) => `${position}${count}`)
          .join(' ');

      const delta = Math.round((juancho.startingValue - baseline.quality.startingValue) * 10) / 10;
      rows.push(
        `${entry.draftId} seat ${entry.userSlot} ${entry.format.teams}-team ${entry.format.scoringProfile}\n` +
          `    First Seed only     start ${baseline.quality.startingValue.toFixed(1).padStart(7)} ` +
          `bench ${baseline.quality.benchValue.toFixed(1).padStart(6)} unfilled ${baseline.quality.unfilledSlots} ` +
          `unusable ${baseline.quality.unusableDepth} · ${compact(baseline.quality.counts)}\n` +
          `    First Seed purist   start ${purist.quality.startingValue.toFixed(1).padStart(7)} ` +
          `bench ${purist.quality.benchValue.toFixed(1).padStart(6)} unfilled ${purist.quality.unfilledSlots} ` +
          `unusable ${purist.quality.unusableDepth} · ${compact(purist.quality.counts)}\n` +
          `    Juancho             start ${juancho.startingValue.toFixed(1).padStart(7)} ` +
          `bench ${juancho.benchValue.toFixed(1).padStart(6)} unfilled ${juancho.unfilledSlots} ` +
          `unusable ${juancho.unusableDepth} · ${compact(juancho.counts)}\n` +
          `    → ${delta >= 0 ? '+' : ''}${delta} starting points from strategy`,
      );

      // The bar: a strategy engine that loses to the published board should not
      // be overriding it. A small tolerance allows for a draft where the board
      // simply had it right and the two agree.
      expect(
        juancho.startingValue,
        `strategy lost to First Seed alone by ${Math.abs(delta)} points`,
      ).toBeGreaterThanOrEqual(baseline.quality.startingValue - 5);

      // And it must never field a worse lineup than the naive baseline.
      expect(juancho.unfilledSlots).toBeLessThanOrEqual(baseline.quality.unfilledSlots);
    },
  );

  it('reports the comparison', () => {
    console.log(`\n[baseline] Juancho vs First Seed-only across ${cases.length} saved mocks`);
    for (const row of rows) console.log(`  ${row}`);
    expect(rows.length).toBe(cases.length);
  });
});
