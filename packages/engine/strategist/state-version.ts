/**
 * Which board a piece of advice is about, and whether it still applies.
 *
 * The strategist is asked a question about pick 47 and answers some seconds
 * later. By then the room may be on pick 49, two players it recommended may be
 * gone, and its reasoning about who survives to our turn is about a draft that
 * no longer exists. Stale advice is not merely unhelpful - applied silently it
 * is worse than none, because it looks exactly like fresh advice.
 *
 * So every brief carries the exact state it was built from, every reply carries
 * that state back, and advice is only ever applied to the state it names.
 */
import type { DraftBoardState } from '../draft/types';
import type { DraftStateVersion } from './types';

/**
 * A fingerprint of the drafted set.
 *
 * FNV-1a over the drafted ids in pick order. Pick COUNT alone is not enough:
 * Sleeper occasionally corrects a selection rather than appending one, which
 * leaves the count identical while changing who is available. Order is included
 * because two different boards can hold the same players.
 *
 * No timestamp and no randomness, so the same board always fingerprints the
 * same way and a replayed case is byte-identical to its capture.
 */
export function fingerprintBoard(orderedSleeperIds: string[]): string {
  let hash = 0x811c9dc5;
  for (const id of orderedSleeperIds) {
    for (let index = 0; index < id.length; index += 1) {
      hash ^= id.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= 0x2c; // separator, so ["1","23"] and ["12","3"] differ
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${orderedSleeperIds.length.toString(36)}-${hash.toString(16).padStart(8, '0')}`;
}

export function buildDraftStateVersion({
  draftId,
  board,
  orderedSleeperIds,
  onTheClockRosterId,
  ourRosterId,
}: {
  draftId: string;
  board: DraftBoardState;
  orderedSleeperIds: string[];
  onTheClockRosterId: number | null;
  ourRosterId: number | null;
}): DraftStateVersion {
  return {
    draftId,
    picksMade: board.picksMade,
    currentOverallPick: board.currentOverallPick,
    currentRound: board.currentRound,
    boardFingerprint: fingerprintBoard(orderedSleeperIds),
    onTheClockRosterId,
    isOurSelection: onTheClockRosterId !== null && onTheClockRosterId === ourRosterId,
  };
}

/**
 * Do these describe the same board?
 *
 * Deliberately strict. Anything short of an exact match means at least one pick
 * has changed, and there is no partial credit for advice about a board that has
 * moved - the cheap, correct response is to fall back to the deterministic
 * recommendation and ask again.
 */
export function isSameDraftState(a: DraftStateVersion, b: DraftStateVersion): boolean {
  return (
    a.draftId === b.draftId &&
    a.picksMade === b.picksMade &&
    a.boardFingerprint === b.boardFingerprint
  );
}

export type StalenessReason =
  | 'different_draft'
  | 'board_advanced'
  | 'board_rewound'
  | 'board_diverged';

/**
 * Why advice cannot be applied to the current board, or `null` if it can.
 *
 * The reason is separated from the yes/no because they are audited differently:
 * `board_advanced` is the ordinary race and says the call was simply too slow,
 * while `board_diverged` at an unchanged pick count means the room's history
 * was rewritten underneath us and is worth noticing.
 */
export function stalenessOf(
  advice: DraftStateVersion,
  current: DraftStateVersion,
): StalenessReason | null {
  if (advice.draftId !== current.draftId) return 'different_draft';
  if (advice.picksMade < current.picksMade) return 'board_advanced';
  if (advice.picksMade > current.picksMade) return 'board_rewound';
  if (advice.boardFingerprint !== current.boardFingerprint) return 'board_diverged';
  return null;
}
