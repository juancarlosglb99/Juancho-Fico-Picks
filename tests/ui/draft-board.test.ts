import { describe, expect, it } from 'vitest';
import { buildDraftBoard, roundDirection } from '../../packages/ui/draft-board';
import { makePicks, scenario } from './scenario';

const teamName = (rosterId: number | null, draftSlot: number) =>
  rosterId === null ? `Slot ${draftSlot}` : `Team ${rosterId}`;

function board() {
  const state = scenario({ picksMade: 14 });
  return buildDraftBoard({
    picks: state.picks,
    teams: 12,
    rounds: 15,
    draftType: 'snake',
    currentOverallPick: state.board.currentOverallPick,
    players: state.players,
    slotToRosterId: state.draft.slot_to_roster_id,
    ourRosterId: state.context.draftState.value.userRosterId,
    ourDraftSlot: state.context.draftState.value.userDraftSlot,
    teamNameFor: teamName,
  });
}

describe('draft board grid', () => {
  it('lays out every selection of the draft, one cell per pick', () => {
    const model = board();
    expect(model.columns).toHaveLength(12);
    expect(model.rounds).toHaveLength(15);
    for (const round of model.rounds) expect(round.cells).toHaveLength(12);

    const everyPick = model.rounds.flatMap((round) => round.cells.map((cell) => cell.overallPick));
    expect(new Set(everyPick).size).toBe(180);
    expect(Math.min(...everyPick)).toBe(1);
    expect(Math.max(...everyPick)).toBe(180);
  });

  it('snakes the direction: round two runs right to left', () => {
    const model = board();
    const roundOne = model.rounds[0].cells;
    const roundTwo = model.rounds[1].cells;

    // Column order is always by draft slot, so the SNAKE shows up in the pick
    // numbers: slot 1 picks first in round one and last in round two.
    expect(roundOne[0].overallPick).toBe(1);
    expect(roundOne[11].overallPick).toBe(12);
    expect(roundTwo[0].overallPick).toBe(24);
    expect(roundTwo[11].overallPick).toBe(13);
  });

  it('reports the reversal for a snake and never for a linear draft', () => {
    expect(roundDirection(1, 'snake')).toBe('forward');
    expect(roundDirection(2, 'snake')).toBe('reverse');
    expect(roundDirection(2, 'linear')).toBe('forward');
    // Third-round reversal turns rounds 2, 3, 5, 7 … around.
    expect(roundDirection(2, '3rr')).toBe('reverse');
    expect(roundDirection(3, '3rr')).toBe('reverse');
    expect(roundDirection(4, '3rr')).toBe('forward');
  });

  it('fills made selections and leaves future ones empty', () => {
    const model = board();
    const made = model.rounds
      .flatMap((round) => round.cells)
      .filter((cell) => cell.player !== null);
    expect(made).toHaveLength(14);
    expect(made.every((cell) => cell.overallPick <= 14)).toBe(true);

    const first = model.rounds[0].cells[0];
    expect(first.player?.name).toBeTruthy();
    expect(first.player?.position).toBeTruthy();
  });

  it('marks the current selection and the most recent one distinctly', () => {
    const model = board();
    const cells = model.rounds.flatMap((round) => round.cells);
    expect(cells.filter((cell) => cell.isCurrent)).toHaveLength(1);
    expect(cells.find((cell) => cell.isCurrent)?.overallPick).toBe(15);
    expect(cells.filter((cell) => cell.isMostRecent)).toHaveLength(1);
    expect(cells.find((cell) => cell.isMostRecent)?.overallPick).toBe(14);
  });

  it('identifies our column and our selections', () => {
    const model = board();
    expect(model.ourColumnIndex).toBe(2);
    expect(model.columns[2].isUs).toBe(true);
    const ours = model.rounds
      .flatMap((round) => round.cells)
      .filter((cell) => cell.isOurs)
      .map((cell) => cell.overallPick);
    // Slot 3 in a twelve-team snake: 3, 22, 27, 46, …
    expect(ours.slice(0, 4)).toEqual([3, 22, 27, 46]);
  });

  it('names a player from Sleeper metadata even when the player map has no entry', () => {
    const state = scenario({ picksMade: 1 });
    const orphan = {
      ...makePicks({ count: 1 })[0],
      player_id: 'not-in-the-map',
      metadata: { first_name: 'Buffalo', last_name: 'Bills', position: 'DEF', team: 'BUF' },
    };
    const model = buildDraftBoard({
      picks: [orphan],
      teams: 12,
      rounds: 15,
      draftType: 'snake',
      currentOverallPick: 2,
      players: state.players,
      slotToRosterId: state.draft.slot_to_roster_id,
      ourRosterId: 3,
      ourDraftSlot: 3,
      teamNameFor: teamName,
    });
    const cell = model.rounds[0].cells[0];
    expect(cell.player?.name).toBe('Buffalo Bills');
    expect(cell.player?.position).toBe('DEF');
    expect(cell.player?.playerId).toBeNull();
  });

  it('attributes a mock draft pick by slot when Sleeper reports no roster id', () => {
    const state = scenario({ picksMade: 3 });
    const mockPicks = state.picks.map((pick) => ({
      ...pick,
      roster_id: null as unknown as string,
    }));
    const model = buildDraftBoard({
      picks: mockPicks,
      teams: 12,
      rounds: 15,
      draftType: 'snake',
      currentOverallPick: 4,
      players: state.players,
      slotToRosterId: null,
      ourRosterId: null,
      ourDraftSlot: 3,
      teamNameFor: teamName,
    });
    expect(model.rounds[0].cells[2].pickedByRosterId).toBe(3);
    expect(model.rounds[0].cells[2].isOurs).toBe(true);
  });
});
