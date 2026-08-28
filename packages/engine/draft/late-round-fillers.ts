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
 *
 * WHICH kickers get offered is a separate question, and it used to have an
 * embarrassing answer. With every candidate worth the same nominal number, the
 * only thing separating them was the order they arrived in - and the player map
 * is sorted by name, so the shortlist was the first six alphabetically. Every
 * draft, in every league, forever: Adam Vinatieri, Aldrick Rosas, Alex Hale.
 *
 * A supplemental ranking source fixes the ORDER without touching the value. The
 * nominal points stay exactly what they were, because a rank is an ordering and
 * turning one into points would be inventing a projection.
 *
 * WHAT THIS STILL DOES NOT FIX, and is deliberately deferred.
 *
 * Every candidate here is worth the same nominal number, so the shortlist is now
 * made of real, current kickers - but their ORDER inside it is still decided by
 * a tie-break the engine does not intend as a preference. On the saved corpus
 * that surfaces as Cam Little (FantasyPros K4) ranked above Cameron Dicker (K2):
 * both are worth 125, the decision value ties, and `consensusRank` breaks it.
 *
 * Making the engine genuinely prefer K1 to K7 means giving them different
 * values, which is a change to the recommendation model rather than to a data
 * source - so it is an intentional valuation change, to be made and measured on
 * its own, not slipped in beside a source fix. Until then the expert rank is
 * displayed next to each option so the arbitrariness is at least visible to the
 * person making the pick.
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

/** How many of each position to put in front of the ranking engine. */
export const FILLER_SHORTLIST = 6;

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
  expertRankOf,
}: {
  board: DraftBoardState;
  slots: LineupSlots;
  /** Positions already on our roster, with counts. */
  heldPositions: Partial<Record<Position, number>>;
  /** Player ids that already have a real projection, so we never duplicate one. */
  alreadyProjected: Set<string>;
  /**
   * Positional rank from a supplemental source, or null where it has none.
   *
   * Ordering only. Nothing derived from this reaches the value of the pick.
   */
  expertRankOf?: (playerId: string) => number | null;
}): MappedProjection[] {
  if (!shouldOfferFillers(board)) return [];

  const wanted: Position[] = [];
  if (slots.K > 0 && (heldPositions.K ?? 0) < slots.K) wanted.push('K');
  if (slots.DEF > 0 && (heldPositions.DEF ?? 0) < slots.DEF) wanted.push('DEF');
  if (wanted.length === 0) return [];

  const fillers: MappedProjection[] = [];
  for (const position of wanted) {
    const projection = NOMINAL_PROJECTION[position] ?? 100;
    const rankOf = (playerId: string) =>
      expertRankOf?.(playerId) ?? Number.MAX_SAFE_INTEGER;
    const candidates = board.availablePlayers
      .filter((player) => player.position === position && !alreadyProjected.has(player.id))
      /*
       * Best first by the supplemental board, unranked last, ties broken by
       * name so the same board always yields the same shortlist. Without a
       * source this degrades to exactly what it was: stable, and admittedly
       * arbitrary.
       */
      .sort(
        (a, b) => rankOf(a.id) - rankOf(b.id) || a.name.localeCompare(b.name),
      )
      .slice(0, FILLER_SHORTLIST);
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
