import type { Position } from '../../players/types';
import type { SleeperTradedPick } from '../../sleeper/types';
import { clamp, normalCdf, round } from './math';

export type NormalizedDraftType =
  | 'snake'
  | 'linear'
  | '3rr'
  | 'auction'
  | 'unknown';

export function slotForOverallPick(
  overallPick: number,
  teams: number,
  draftType: NormalizedDraftType,
): number {
  const roundNumber = Math.ceil(overallPick / teams);
  const pickInRound = ((overallPick - 1) % teams) + 1;
  if (draftType === '3rr') {
    const reverse = roundNumber === 2 || (roundNumber >= 3 && roundNumber % 2 === 1);
    return reverse ? teams + 1 - pickInRound : pickInRound;
  }
  if (draftType === 'snake' && roundNumber % 2 === 0) {
    return teams + 1 - pickInRound;
  }
  return pickInRound;
}

export function findNextUserSelection(
  currentOverallPick: number,
  teams: number,
  rounds: number,
  draftType: NormalizedDraftType,
  userSlot: number | null,
  ownership?: {
    userRosterId: number | null;
    slotToRosterId: Record<string, number> | null;
    tradedPicks: SleeperTradedPick[];
  },
): number | null {
  const totalPicks = teams * rounds;
  if (draftType === 'auction' || draftType === 'unknown') return null;
  if (userSlot === null && ownership?.userRosterId === null) return null;

  for (let pick = currentOverallPick; pick <= totalPicks; pick += 1) {
    const slot = slotForOverallPick(pick, teams, draftType);
    const round = Math.ceil(pick / teams);
    const originalRosterId = ownership?.slotToRosterId?.[String(slot)] ?? null;
    const traded = ownership?.tradedPicks.find(
      (candidate) =>
        candidate.round === round && candidate.roster_id === originalRosterId,
    );
    const ownerRosterId = traded?.owner_id ?? originalRosterId;
    const isUserSelection =
      ownership?.userRosterId !== null && ownership?.userRosterId !== undefined
        ? ownerRosterId === ownership.userRosterId
        : slot === userSlot;
    if (isUserSelection && pick > currentOverallPick) {
      return pick;
    }
  }
  return null;
}

export function getInterveningDraftSlots(
  currentOverallPick: number,
  nextUserPick: number | null,
  teams: number,
  draftType: NormalizedDraftType,
): number[] {
  if (nextUserPick === null) return [];
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
