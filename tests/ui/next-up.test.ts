import { describe, expect, it } from 'vitest';
import { buildNextUp } from '../../packages/ui/next-up';
import { scenario } from './scenario';

const state = scenario({ picksMade: 26 });
const model = buildNextUp({ result: state.result, brief: state.brief })!;

describe('what happens next', () => {
  it('says when our next turn is and how far away it is', () => {
    expect(model.ourNextPick).toBe(state.result.nextUserPick);
    expect(model.picksUntilTurn).toBe(state.result.picksUntilNextUserPick);
    expect(model.backToBack).toBe(state.result.picksUntilNextUserPick === 0);
  });

  it('separates the players at risk from the ones that will come back', () => {
    for (const row of model.atRisk) expect(row.survival).toBeLessThanOrEqual(55);
    for (const row of model.likelyToReturn) expect(row.survival).toBeGreaterThanOrEqual(80);
    const risky = model.atRisk.map((row) => row.playerId);
    expect(model.likelyToReturn.every((row) => !risky.includes(row.playerId))).toBe(true);
    // Most endangered first, so the rail leads with the real decision.
    const survivals = model.atRisk.map((row) => row.survival);
    expect([...survivals].sort((a, b) => a - b)).toEqual(survivals);
  });

  it('puts the tiers we can actually start somebody from first', () => {
    const needed = model.cliffs.filter((cliff) => cliff.weNeedIt);
    const rest = model.cliffs.filter((cliff) => !cliff.weNeedIt);
    expect(model.cliffs.slice(0, needed.length)).toEqual(needed);
    expect(model.cliffs.slice(needed.length)).toEqual(rest);
  });

  it('lists only teams competing for a position we still need', () => {
    const ourNeeds = new Set(
      state.brief.ourTeam.needs
        .filter((need) => need.openStartingSlots > 0)
        .map((need) => need.position),
    );
    for (const threat of model.threats) {
      expect(threat.competingFor.length).toBeGreaterThan(0);
      for (const entry of threat.competingFor) {
        expect(ourNeeds.has(entry.position)).toBe(true);
        expect(entry.openStartingSlots).toBeGreaterThan(0);
      }
    }
    // Never every team between here and our turn - only the ones that matter.
    expect(model.threats.length).toBeLessThanOrEqual(5);
  });

  it('names who the simulation expects to still be on the board', () => {
    expect(model.runs).toBeGreaterThan(0);
    expect(model.likelyBestAvailable.length).toBeGreaterThan(0);
    for (const entry of model.likelyBestAvailable) {
      expect(entry.frequency).toBeGreaterThan(0);
      expect(entry.name).not.toBe(entry.playerId);
    }
  });

  it('shows no opponents and no cliffs rather than guessing without a brief', () => {
    const blind = buildNextUp({ result: state.result, brief: null })!;
    expect(blind.threats).toEqual([]);
    expect(blind.cliffs).toEqual([]);
    // The parts that come from the engine alone survive.
    expect(blind.likelyBestAvailable.length).toBeGreaterThan(0);
    expect(blind.ourNextPick).toBe(model.ourNextPick);
  });

  it('names teams through the resolver, because a mock has no team names', () => {
    const named = buildNextUp({
      result: state.result,
      brief: state.brief,
      teamNameFor: (rosterId) => (rosterId === null ? null : `Seat ${rosterId}`),
    })!;
    for (const threat of named.threats) {
      expect(threat.teamName).toMatch(/^Seat \d+$/);
    }
    // Without a resolver it falls back rather than showing nothing.
    for (const threat of model.threats) {
      expect(threat.teamName).toBeTruthy();
    }
  });

  it('returns nothing when the engine kept no internals', () => {
    expect(buildNextUp({ result: { ...state.result, internals: undefined }, brief: state.brief })).toBeNull();
  });
});
