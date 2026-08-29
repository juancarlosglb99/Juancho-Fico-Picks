/**
 * Compare has to answer before it argues.
 *
 * The verdict is the ENGINE's ordering rendered in words - not a second opinion
 * - so these tests pin the two things that would make it dishonest: preferring
 * the wrong player, and asserting a view where the engine has none.
 */
import { describe, expect, it } from 'vitest';
import { buildCompareVerdict } from '../../packages/ui/compare-verdict';
import { buildPlayerAnalysis, type PlayerAnalysis } from '../../packages/ui/player-analysis';
import { scenario } from './scenario';

const state = scenario({ picksMade: 26 });
const drafted = new Set<string>();

function analyse(playerId: string): PlayerAnalysis {
  return buildPlayerAnalysis({
    playerId,
    result: state.result,
    brief: state.brief,
    draftedPlayerIds: drafted,
  })!;
}

const top = analyse(state.result.recommendations[0].player.id);
const second = analyse(state.result.recommendations[1].player.id);
const deep = analyse(state.result.recommendations[6].player.id);

describe("Juancho's take", () => {
  it('names the engine’s own preference as the verdict', () => {
    // Deliberately passed in the wrong order: the verdict is not "the first one".
    const verdict = buildCompareVerdict([second, top])!;
    expect(verdict.winnerId).toBe(top.header.playerId);
    expect(verdict.summary).toBe(`${top.header.name} is the better fit for your roster.`);
    expect(verdict.caveat).toBeNull();
  });

  it('explains itself in sentences, not metrics', () => {
    const verdict = buildCompareVerdict([top, second])!;
    expect(verdict.reasons.length).toBeGreaterThan(0);
    expect(verdict.reasons.length).toBeLessThanOrEqual(3);
    for (const reason of verdict.reasons) {
      expect(reason.length).toBeGreaterThan(20);
      expect(reason).not.toMatch(/tier|VORP|simGap|decisionValue/i);
      // No raw floats anywhere a reader can see.
      expect(reason).not.toMatch(/\d+\.\d{3,}/);
    }
  });

  it('gives each player the condition under which he is the right call', () => {
    const verdict = buildCompareVerdict([top, second])!;
    expect(verdict.cases).toHaveLength(2);
    expect(verdict.cases.map((entry) => entry.playerId).sort()).toEqual(
      [top.header.playerId, second.header.playerId].sort(),
    );
    for (const option of verdict.cases) {
      expect(option.when.length).toBeGreaterThan(10);
      expect(option.when[0]).toBe(option.when[0].toLowerCase());
    }
  });

  it('grades the edge rather than leaving the reader to size it', () => {
    expect(['slight', 'moderate', 'strong']).toContain(
      buildCompareVerdict([top, second])!.edge,
    );
    // A wider gap should never read as a smaller edge than a narrow one.
    const near = buildCompareVerdict([top, second])!.edge;
    const far = buildCompareVerdict([top, deep])!.edge;
    const order = { slight: 0, moderate: 1, strong: 2 };
    expect(order[far]).toBeGreaterThanOrEqual(order[near]);
  });

  it('says so when the engine has no opinion about either player', () => {
    const unranked = [
      { ...top, header: { ...top.header, engineRank: null, leagueProjection: 200 } },
      { ...second, header: { ...second.header, engineRank: null, leagueProjection: 150 } },
    ];
    const verdict = buildCompareVerdict(unranked)!;
    expect(verdict.caveat).toContain('shortlist');
    expect(verdict.summary).toContain('higher-projected');
    expect(verdict.winnerId).toBe(top.header.playerId);
  });

  it('has nothing to say about one player', () => {
    expect(buildCompareVerdict([top])).toBeNull();
    expect(buildCompareVerdict([])).toBeNull();
  });
});
