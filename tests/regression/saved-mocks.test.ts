/**
 * Replays every mock ever captured against the current engine.
 *
 * This is the safety net for the whole project. Each case is a real draft that
 * really happened, pinned to the data that was live at the time, so a change to
 * the engine can be measured rather than argued about: same seat, same board,
 * same projections, different code.
 *
 * It runs inside `npm test` and needs no network - everything is on disk.
 *
 * Add a case with:
 *
 *     npm run capture -- "<draft link>" "<sleeper username>"
 */
import { describe, expect, it } from 'vitest';
import {
  replayRegressionCase,
  type RegressionCase,
  type ReplayResult,
} from '../../packages/engine/benchmark/case';
import {
  listCases,
  readPlayerSnapshot,
  readProjectionSnapshot,
  readRoomSnapshot,
} from '../../packages/engine/benchmark/store';
import { buildDraftAttachment } from '../../packages/sleeper/attachment';
import { buildCanonicalPlayerMap } from '../../packages/players/player-map';
import type { CanonicalPlayerMap } from '../../packages/players/types';
import type { SleeperDraft } from '../../packages/sleeper/types';

const cases = listCases();

/** The exact pool the capture faced, read back from disk. */
function playersFor(regression: RegressionCase): CanonicalPlayerMap {
  return buildCanonicalPlayerMap(readPlayerSnapshot(regression.playersRef));
}

function draftFor(regression: RegressionCase): SleeperDraft {
  const slots = regression.format.rosterSlots;
  return {
    draft_id: regression.draftId,
    league_id: regression.format.isMock ? null : `league-${regression.draftId}`,
    status: 'complete',
    type: regression.format.draftType === 'unknown' ? 'snake' : regression.format.draftType,
    season: '2026',
    start_time: null,
    last_picked: null,
    settings: {
      teams: regression.format.teams,
      rounds: regression.format.rounds,
      slots_qb: slots.QB,
      slots_rb: slots.RB,
      slots_wr: slots.WR,
      slots_te: slots.TE,
      slots_flex: slots.FLEX,
      slots_super_flex: slots.SUPER_FLEX,
      slots_k: slots.K,
      slots_def: slots.DEF,
      slots_bn: slots.bench,
    },
    metadata: { name: `Regression ${regression.draftId}` },
    draft_order: { [regression.userId]: regression.userSlot },
    slot_to_roster_id: Object.fromEntries(
      Array.from({ length: regression.format.teams }, (_, index) => [
        String(index + 1),
        index + 1,
      ]),
    ),
  } as SleeperDraft;
}

function replay(regression: RegressionCase): ReplayResult {
  const players = playersFor(regression);
  const draft = draftFor(regression);
  const attachment = buildDraftAttachment({ draft, league: null, rosters: null });
  return replayRegressionCase({
    regression,
    projections: readProjectionSnapshot(regression.projectionsRef),
    roomRankings: regression.roomRankingsRef
      ? readRoomSnapshot(regression.roomRankingsRef)
      : null,
    players,
    league: attachment.league,
    draft,
    rosters: attachment.rosters,
  });
}

describe('saved mock drafts', () => {
  it('has a corpus to replay', () => {
    // An empty corpus is a silent hole in the safety net, not a pass.
    expect(cases.length).toBeGreaterThan(0);
  });

  describe.each(cases.map((entry) => ({ entry, name: `${entry.draftId} (${entry.format.teams}-team ${entry.format.scoringProfile} ${entry.format.qbFormat}, seat ${entry.userSlot})` })))(
    '$name',
    ({ entry }) => {
      const result = replay(entry);
      const slots = entry.format.rosterSlots;

      it('fields a legal starting lineup', () => {
        expect(result.quality.roster.unfilledSlots).toBe(0);
      });

      it('does not hoard a position it cannot start', () => {
        const counts = result.quality.roster.counts;
        const quarterbacks = counts.QB ?? 0;
        // One starting slot means one starter and at most one backup.
        const allowed = slots.SUPER_FLEX > 0 ? 3 : 2;
        expect(quarterbacks).toBeLessThanOrEqual(allowed);
        if (slots.SUPER_FLEX > 0) expect(quarterbacks).toBeGreaterThanOrEqual(2);
        expect(counts.TE ?? 0).toBeLessThanOrEqual(3);
      });

      it('gives no unexplained contradictions', () => {
        expect(result.contradictions).toEqual([]);
      });

      it('is at least as good as the recorded baseline', () => {
        const baseline = entry.baseline.quality;
        const now = result.quality.roster;
        // A small tolerance: the corpus exists to catch real regressions, not
        // to freeze the engine against every rounding difference.
        expect(now.startingValue).toBeGreaterThanOrEqual(baseline.startingValue - 25);
        expect(now.unfilledSlots).toBeLessThanOrEqual(baseline.unfilledSlots);
        expect(now.unusableDepth).toBeLessThanOrEqual(baseline.unusableDepth + 1);
      });

      it('answers every pick well inside the compute budget', () => {
        // Recommendation compute is the part of end-to-end latency we own.
        const slowest = Math.max(...result.computeMs);
        expect(slowest).toBeLessThan(400);
      });
    },
  );

  it('reports the corpus', () => {
    const lines: string[] = [];
    for (const entry of cases) {
      const result = replay(entry);
      const baseline = entry.baseline.quality;
      const now = result.quality.roster;
      const delta = Math.round((now.startingValue - baseline.startingValue) * 10) / 10;
      lines.push(
        `${entry.draftId} seat ${entry.userSlot} ${entry.format.teams}-team ${entry.format.scoringProfile}: ` +
          `starting ${now.startingValue} (${delta >= 0 ? '+' : ''}${delta} vs baseline) · ` +
          `unfilled ${now.unfilledSlots} · unusable ${now.unusableDepth} · ` +
          `meanRegret ${result.quality.meanRegret} · ` +
          `compute p50 ${median(result.computeMs).toFixed(1)}ms max ${Math.max(...result.computeMs).toFixed(1)}ms · ` +
          Object.entries(now.counts)
            .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
            .map(([position, count]) => `${position}${count}`)
            .join(' '),
      );
    }
    console.log(`\n[corpus] ${cases.length} saved mock${cases.length === 1 ? '' : 's'}`);
    for (const line of lines) console.log(`  ${line}`);
    expect(lines.length).toBe(cases.length);
  });
});

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}
