/**
 * The draft board: teams across, rounds down.
 *
 * The grid is built by walking overall picks 1..teams×rounds and asking the
 * engine's own `slotForOverallPick` where each one lands. That matters more
 * than it looks: snake, linear and third-round-reversal all put pick 25 in a
 * different column, and a board that draws the order itself would be a second
 * implementation of the rule that decides when our next turn is. One of the two
 * would eventually be wrong, and it would be this one.
 *
 * Columns are DRAFT SLOTS, not rosters. That is what a Sleeper board is, it is
 * what survives a traded pick, and it is the only identity a mock draft has -
 * mock picks carry a slot and no roster id at all.
 */
import { slotForOverallPick, type NormalizedDraftType } from '../engine/draft/next-pick-probability';
import { resolvePickRosterId, type SlotToRosterId } from '../engine/draft/pick-ownership';
import type { CanonicalPlayerMap, Position } from '../players/types';
import type { SleeperDraftPick } from '../sleeper/types';

export interface BoardColumn {
  draftSlot: number;
  rosterId: number | null;
  teamName: string;
  isUs: boolean;
}

export interface BoardCell {
  overallPick: number;
  round: number;
  draftSlot: number;
  /** Null until the selection is made. */
  player: {
    playerId: string | null;
    sleeperId: string;
    name: string;
    /** Two lines read better than one on a narrow column. */
    firstName: string;
    lastName: string;
    position: Position | null;
    team: string | null;
  } | null;
  /** The roster that actually made the pick, which a trade can change. */
  pickedByRosterId: number | null;
  isOurs: boolean;
  isCurrent: boolean;
  /** The most recent selection in the room, for a brief highlight. */
  isMostRecent: boolean;
  isKeeper: boolean;
}

export interface DraftBoardModel {
  columns: BoardColumn[];
  /** One entry per round, each already in column order. */
  rounds: { round: number; cells: BoardCell[] }[];
  teams: number;
  totalRounds: number;
  currentOverallPick: number;
  ourColumnIndex: number | null;
}

export function buildDraftBoard({
  picks,
  teams,
  rounds,
  draftType,
  currentOverallPick,
  players,
  slotToRosterId,
  ourRosterId,
  ourDraftSlot,
  teamNameFor,
}: {
  picks: SleeperDraftPick[];
  teams: number;
  rounds: number;
  draftType: NormalizedDraftType;
  currentOverallPick: number;
  players: CanonicalPlayerMap;
  slotToRosterId: SlotToRosterId;
  ourRosterId: number | null;
  ourDraftSlot: number | null;
  teamNameFor: (rosterId: number | null, draftSlot: number) => string;
}): DraftBoardModel {
  const byOverall = new Map<number, SleeperDraftPick>();
  let mostRecent = 0;
  for (const pick of picks) {
    byOverall.set(pick.pick_no, pick);
    if (pick.pick_no > mostRecent) mostRecent = pick.pick_no;
  }

  const columns: BoardColumn[] = Array.from({ length: teams }, (_, index) => {
    const draftSlot = index + 1;
    const rosterId = slotToRosterId?.[String(draftSlot)] ?? draftSlot;
    return {
      draftSlot,
      rosterId,
      teamName: teamNameFor(rosterId, draftSlot),
      isUs:
        ourRosterId !== null ? rosterId === ourRosterId : ourDraftSlot === draftSlot,
    };
  });

  const grid: { round: number; cells: BoardCell[] }[] = [];
  for (let round = 1; round <= rounds; round += 1) {
    const cells: BoardCell[] = new Array(teams);
    for (let pickInRound = 1; pickInRound <= teams; pickInRound += 1) {
      const overallPick = (round - 1) * teams + pickInRound;
      const draftSlot = slotForOverallPick(overallPick, teams, draftType);
      const pick = byOverall.get(overallPick) ?? null;
      const pickedByRosterId = pick ? resolvePickRosterId(pick, slotToRosterId) : null;
      const column = columns[draftSlot - 1];

      cells[draftSlot - 1] = {
        overallPick,
        round,
        draftSlot,
        player: pick ? describePick(pick, players) : null,
        pickedByRosterId,
        isOurs:
          pickedByRosterId !== null && ourRosterId !== null
            ? pickedByRosterId === ourRosterId
            : (column?.isUs ?? false),
        isCurrent: overallPick === currentOverallPick,
        isMostRecent: mostRecent > 0 && overallPick === mostRecent,
        isKeeper: pick?.is_keeper === true,
      };
    }
    grid.push({ round, cells });
  }

  const ourColumnIndex = columns.findIndex((column) => column.isUs);

  return {
    columns,
    rounds: grid,
    teams,
    totalRounds: rounds,
    currentOverallPick,
    ourColumnIndex: ourColumnIndex === -1 ? null : ourColumnIndex,
  };
}

function describePick(
  pick: SleeperDraftPick,
  players: CanonicalPlayerMap,
): NonNullable<BoardCell['player']> {
  const canonical = players.bySleeperId.get(pick.player_id);
  const first = pick.metadata.first_name?.trim() ?? '';
  const last = pick.metadata.last_name?.trim() ?? '';
  /*
   * Sleeper's pick metadata is the authority for a name here, not the player
   * map: a defense selected in a mock frequently has no entry in the active
   * player map at all, and a blank cell on a finished board reads as a bug.
   */
  const fromMetadata = [first, last].filter(Boolean).join(' ');
  const name = fromMetadata || canonical?.name || pick.player_id;

  return {
    playerId: canonical?.id ?? null,
    sleeperId: pick.player_id,
    name,
    firstName: first || canonical?.name.split(' ')[0] || '',
    lastName: last || canonical?.name.split(' ').slice(1).join(' ') || name,
    position: (canonical?.position ?? (pick.metadata.position as Position | undefined) ?? null),
    team: pick.metadata.team?.trim() || canonical?.team || null,
  };
}

/** The rounds a snake board reverses, so an arrow can be drawn honestly. */
export function roundDirection(
  round: number,
  draftType: NormalizedDraftType,
): 'forward' | 'reverse' {
  if (draftType === '3rr') {
    return round === 2 || (round >= 3 && round % 2 === 1) ? 'reverse' : 'forward';
  }
  if (draftType === 'snake') return round % 2 === 0 ? 'reverse' : 'forward';
  return 'forward';
}
