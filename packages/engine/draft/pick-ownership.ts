/**
 * Works out which team actually made a pick.
 *
 * Sleeper is not consistent here. A league draft returns `roster_id` on every
 * pick. A MOCK draft returns `roster_id: null` on every pick and only sets
 * `draft_slot`. Reading `roster_id` alone therefore silently attributes nobody's
 * picks to anybody in a mock, so the drafting team looks like it never selected
 * a single player - which is exactly how a recommendation engine ends up
 * suggesting a ninth quarterback.
 *
 * `draft_slot` is present in both cases, and `slot_to_roster_id` maps it to the
 * roster, so slot is the reliable route with `roster_id` as a fast path.
 */
import type { SleeperDraft, SleeperDraftPick } from '../../sleeper/types';

export type SlotToRosterId = Record<string, number> | null | undefined;

/** The roster that owns a pick, or null when neither field identifies one. */
export function resolvePickRosterId(
  pick: SleeperDraftPick,
  slotToRosterId: SlotToRosterId,
): number | null {
  const raw = pick.roster_id as unknown;
  if (raw !== null && raw !== undefined && raw !== '') {
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  const slot = pick.draft_slot;
  if (!Number.isFinite(slot) || slot <= 0) return null;
  const mapped = slotToRosterId?.[String(slot)];
  return mapped ?? slot;
}

export function slotToRosterIdFromDraft(draft: SleeperDraft): SlotToRosterId {
  return draft.slot_to_roster_id ?? null;
}

/**
 * How many bench spots the roster really has.
 *
 * Sleeper mock drafts omit `slots_bn` entirely, which used to leave bench at 0
 * even in a 15-round draft with 10 starting spots. Bench size feeds replacement
 * level, so reporting zero makes every position look shallower than it is.
 * Rounds minus starters is the truth whenever the explicit slot count is
 * missing.
 */
export function inferBenchSlots({
  explicitBench,
  rounds,
  totalStarterSpots,
}: {
  explicitBench: number;
  rounds: number | undefined;
  totalStarterSpots: number;
}): number {
  if (explicitBench > 0) return explicitBench;
  if (!Number.isFinite(rounds) || (rounds ?? 0) <= 0) return explicitBench;
  return Math.max(0, (rounds as number) - totalStarterSpots);
}
