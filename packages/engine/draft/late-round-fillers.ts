/**
 * Kickers and defenses, which nobody projects.
 *
 * First Seed publishes quarterbacks, backs, receivers and tight ends - and
 * nothing else. In a league with a K and a DEF slot that left the engine unable
 * to recommend either, so it filled all fifteen rounds with skill players and
 * finished with a lineup that could not legally be fielded. The roster
 * evaluation was quietly carrying two permanently unfilled slots, which dragged
 * every comparison in those leagues down by a fixed amount.
 *
 * There is no honest way to rank kickers without data, and pretending otherwise
 * would be worse than the gap. What this does instead is treat them as
 * interchangeable - which is very close to true - and make sure the last rounds
 * put one of each on the roster. The nominal values below exist only so the
 * lineup solver can fill the slot; they are not a projection and are labelled
 * as such wherever they surface.
 */
import type { Position } from '../../players/types';
import type { MappedProjection } from '../../projections/types';
import type { LineupSlots } from './lineup';
import type { DraftBoardState } from './types';

/** Roughly what a starting kicker and defense score over a season. */
const NOMINAL_PROJECTION: Partial<Record<Position, number>> = {
  K: 125,
  DEF: 115,
};

export const FILLER_SOURCE_LABEL = 'Nominal streaming value (no provider projects this position)';

/**
 * How many rounds from the end we start offering kickers and defenses.
 *
 * Early enough that they cannot be missed, late enough that they never compete
 * with a real starter.
 */
export const FILLER_ROUND_WINDOW = 2;

export function shouldOfferFillers(board: DraftBoardState): boolean {
  return board.currentRound >= Math.max(1, board.rounds - FILLER_ROUND_WINDOW);
}

/**
 * Builds stand-in candidates for any required slot no provider covers.
 *
 * Only positions the league actually starts are offered, only once the draft is
 * nearly over, and only while the slot is still empty - so a roster never
 * collects a second kicker.
 */
export function buildFillerCandidates({
  board,
  slots,
  heldPositions,
  alreadyProjected,
}: {
  board: DraftBoardState;
  slots: LineupSlots;
  /** Positions already on our roster, with counts. */
  heldPositions: Partial<Record<Position, number>>;
  /** Player ids that already have a real projection, so we never duplicate one. */
  alreadyProjected: Set<string>;
}): MappedProjection[] {
  if (!shouldOfferFillers(board)) return [];

  const wanted: Position[] = [];
  if (slots.K > 0 && (heldPositions.K ?? 0) < slots.K) wanted.push('K');
  if (slots.DEF > 0 && (heldPositions.DEF ?? 0) < slots.DEF) wanted.push('DEF');
  if (wanted.length === 0) return [];

  const fillers: MappedProjection[] = [];
  for (const position of wanted) {
    const projection = NOMINAL_PROJECTION[position] ?? 100;
    const candidates = board.availablePlayers
      .filter((player) => player.position === position && !alreadyProjected.has(player.id))
      // Sleeper lists these in no useful order, and there is no data to sort
      // them by, so the ordering is stable rather than meaningful.
      .slice(0, 6);
    for (const player of candidates) {
      fillers.push({
        sourceRow: -1,
        playerName: player.name,
        sleeperId: player.externalIds.sleeper,
        playerId: player.id,
        position,
        team: player.team ?? null,
        projection,
        projectionSource: FILLER_SOURCE_LABEL,
        matchMethod: 'sleeper-id',
        matchConfidence: 1,
      } as MappedProjection);
    }
  }
  return fillers;
}
