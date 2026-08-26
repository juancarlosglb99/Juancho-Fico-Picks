/**
 * Rebuilds a saved case into something the engine can be run against.
 *
 * Shared by the quality regression and the First Seed deviation audit, so both
 * are guaranteed to be looking at the same reconstruction of the same draft.
 */
import {
  replayRegressionCase,
  type RegressionCase,
  type ReplayResult,
} from '../../packages/engine/benchmark/case';
import {
  readPlayerSnapshot,
  readProjectionSnapshot,
  readRoomSnapshot,
} from '../../packages/engine/benchmark/store';
import { buildDraftAttachment } from '../../packages/sleeper/attachment';
import { buildCanonicalPlayerMap } from '../../packages/players/player-map';
import type { CanonicalPlayerMap } from '../../packages/players/types';
import type { SleeperDraft } from '../../packages/sleeper/types';

/** The exact pool the capture faced, read back from disk. */
export function playersFor(regression: RegressionCase): CanonicalPlayerMap {
  return buildCanonicalPlayerMap(readPlayerSnapshot(regression.playersRef));
}

export function draftFor(regression: RegressionCase): SleeperDraft {
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

/**
 * The same saved draft, seen from a different seat.
 *
 * Two captured mocks is a thin basis for judging a ranking rule, but each one
 * contains a whole room. Replaying a real board from every seat keeps the data
 * real - the same players went in the same order - while multiplying the number
 * of situations the engine has to get right, and seat position changes the
 * problem substantially: who is gone by your turn, how long you wait, whether
 * you pick back-to-back.
 */
export function atSeat(regression: RegressionCase, userSlot: number): RegressionCase {
  return { ...regression, userSlot };
}

export function replayCase(regression: RegressionCase): ReplayResult {
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

