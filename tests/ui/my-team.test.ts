import { describe, expect, it } from 'vitest';
import { deriveMyTeam } from '../../packages/ui/my-team';
import { makeRosters } from '../engine/fixtures';
import { scenario } from './scenario';

function team({ picksMade = 26 }: { picksMade?: number } = {}) {
  const state = scenario({ picksMade });
  const projections = new Map(
    (state.result.internals?.candidatePool ?? []).map((candidate) => [
      candidate.playerId,
      candidate.projection,
    ]),
  );
  // Everyone drafted has left the candidate pool, so their points come from the
  // brief's roster instead - which is where the rail gets them in the app too.
  for (const player of state.brief.ourTeam.players) {
    projections.set(player.playerId, player.projectedPoints);
  }
  return deriveMyTeam({
    rosterId: state.context.draftState.value.userRosterId,
    picks: state.picks,
    rosters: makeRosters(12),
    players: state.players,
    projections,
    roster: state.context.roster.value,
    benchSlots: state.context.roster.value.bench,
    slotToRosterId: state.draft.slot_to_roster_id,
  });
}

describe('my team rail', () => {
  it('shows one row per starting slot, filled or not', () => {
    const model = team();
    const slots = state();
    expect(model.starters).toHaveLength(
      slots.QB + slots.RB + slots.WR + slots.TE + slots.FLEX + slots.SUPER_FLEX + slots.K + slots.DEF,
    );
    // The empty rows are the whole point: a drafter must see the hole.
    expect(model.starters.some((view) => view.player === null)).toBe(true);
    const filled = model.starters.filter((view) => view.player !== null);
    expect(filled.length).toBeGreaterThan(0);
  });

  it('numbers repeated slots so two receivers read WR1 and WR2', () => {
    const model = team();
    const receivers = model.starters.filter((view) => view.slot === 'WR');
    expect(receivers.map((view) => view.index)).toEqual([1, 2]);
  });

  it('puts every drafted player in exactly one place', () => {
    const model = team();
    const startingIds = model.starters
      .filter((view) => view.player !== null)
      .map((view) => view.player!.playerId);
    const benchIds = model.bench.map((entry) => entry.playerId);
    expect(new Set([...startingIds, ...benchIds]).size).toBe(model.totalDrafted);
    expect(startingIds.filter((id) => benchIds.includes(id))).toHaveLength(0);
  });

  it('reports open starting slots as positional need', () => {
    // Two picks in, our seat at slot 3 has not selected yet: every slot is open.
    const empty = team({ picksMade: 2 });
    const quarterback = empty.needs.find((need) => need.position === 'QB');
    expect(quarterback).toEqual({ position: 'QB', filled: 0, required: 1, open: 1 });
    expect(empty.openStartingPositions.map((entry) => entry.position)).toContain('QB');
    expect(empty.openStartingPositions.map((entry) => entry.position)).toContain('TE');

    // After our first selection the filled position stops being a need.
    const started = team({ picksMade: 3 });
    const filled = started.needs.find((need) => need.position === 'QB');
    expect(filled!.filled).toBe(1);
    expect(filled!.open).toBe(0);
    expect(started.openStartingPositions.map((entry) => entry.position)).not.toContain('QB');
    // Two empty receiver slots are one entry with a count, not two entries.
    const receivers = empty.openStartingPositions.find((entry) => entry.position === 'WR');
    expect(receivers).toEqual({ position: 'WR', count: 2 });
  });

  it('works before any projection has loaded', () => {
    const state2 = scenario({ picksMade: 26 });
    const model = deriveMyTeam({
      rosterId: state2.context.draftState.value.userRosterId,
      picks: state2.picks,
      rosters: makeRosters(12),
      players: state2.players,
      projections: new Map(),
      roster: state2.context.roster.value,
      benchSlots: state2.context.roster.value.bench,
      slotToRosterId: state2.draft.slot_to_roster_id,
    });
    expect(model.totalDrafted).toBeGreaterThan(0);
    // Slots still fill by position; the points are simply absent rather than 0.
    expect(model.starters.some((view) => view.player !== null)).toBe(true);
    expect(model.startingPoints).toBeNull();
  });

  it('returns an empty roster rather than throwing when the seat is unknown', () => {
    const state3 = scenario({ picksMade: 10 });
    const model = deriveMyTeam({
      rosterId: null,
      picks: state3.picks,
      rosters: makeRosters(12),
      players: state3.players,
      projections: new Map(),
      roster: state3.context.roster.value,
      benchSlots: 6,
      slotToRosterId: state3.draft.slot_to_roster_id,
    });
    expect(model.totalDrafted).toBe(0);
    expect(model.starters.every((view) => view.player === null)).toBe(true);
  });
});

function state() {
  return scenario({ picksMade: 1 }).result.internals!.slots;
}
