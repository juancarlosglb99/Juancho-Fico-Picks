import type { Position } from '../../players/types';
import type { SleeperDraft, SleeperDraftPick } from '../../sleeper/types';
import { clamp, normalCdf, round } from './math';

export function slotForOverallPick(
  overallPick: number,
  teams: number,
  draftType: string,
): number {
  const roundNumber = Math.ceil(overallPick / teams);
  const pickInRound = ((overallPick - 1) % teams) + 1;
  if (draftType === 'snake' && roundNumber % 2 === 0) {
    return teams + 1 - pickInRound;
  }
  return pickInRound;
}

export function resolveUserDraftSlot(
  draft: SleeperDraft,
  userId: string,
  userRosterId: number | null,
  picks: SleeperDraftPick[],
): number | null {
  const direct = draft.draft_order?.[userId];
  if (direct) return direct;

  if (userRosterId !== null) {
    const slotEntry = Object.entries(draft.slot_to_roster_id ?? {}).find(
      ([, rosterId]) => Number(rosterId) === userRosterId,
    );
    if (slotEntry) return Number(slotEntry[0]);

    const ownPick = picks.find((pick) => Number(pick.roster_id) === userRosterId);
    if (ownPick) return ownPick.draft_slot;
  }
  return null;
}

export function findNextUserSelection(
  currentOverallPick: number,
  teams: number,
  rounds: number,
  draftType: string,
  userSlot: number | null,
): number {
  const totalPicks = teams * rounds;
  if (userSlot === null || draftType === 'auction') {
    return Math.min(totalPicks, currentOverallPick + teams);
  }

  const currentSlot = slotForOverallPick(currentOverallPick, teams, draftType);
  const start = currentSlot === userSlot ? currentOverallPick + 1 : currentOverallPick;
  for (let pick = start; pick <= totalPicks; pick += 1) {
    if (slotForOverallPick(pick, teams, draftType) === userSlot) return pick;
  }
  return totalPicks;
}

export function getInterveningDraftSlots(
  currentOverallPick: number,
  nextUserPick: number,
  teams: number,
  draftType: string,
): number[] {
  const slots: number[] = [];
  for (let pick = currentOverallPick; pick < nextUserPick; pick += 1) {
    slots.push(slotForOverallPick(pick, teams, draftType));
  }
  return slots;
}

export function probabilityAvailableAtNextPick({
  adp,
  currentOverallPick,
  nextUserPick,
  interveningDemand = 0,
  position,
}: {
  adp: number;
  currentOverallPick: number;
  nextUserPick: number;
  interveningDemand?: number;
  position: Position;
}): number {
  if (nextUserPick <= currentOverallPick) return 100;
  const volatility = position === 'QB' || position === 'TE' ? 0.18 : 0.15;
  const standardDeviation = Math.max(4, adp * volatility);
  const survivalAtCurrent = Math.max(
    0.0001,
    1 - normalCdf((currentOverallPick - 0.5 - adp) / standardDeviation),
  );
  const survivalAtNext = Math.max(
    0,
    1 - normalCdf((nextUserPick - 0.5 - adp) / standardDeviation),
  );
  const conditionalSurvival = Math.min(1, survivalAtNext / survivalAtCurrent);
  const demandAdjustment = Math.exp(-0.07 * Math.max(0, interveningDemand));
  return round(clamp(conditionalSurvival * demandAdjustment * 100), 1);
}
