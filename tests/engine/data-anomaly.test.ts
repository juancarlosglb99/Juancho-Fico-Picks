/**
 * When First Seed's two signals contradict each other.
 *
 * James Conner sits at rank 99 while projecting 40.4, against running backs
 * ranked around him projecting near a hundred. Both the engine and the
 * strategist took the pair at face value - one anchoring to the rank, the other
 * reasoning carefully about sequencing a player worth a quarter of the
 * alternative. Neither noticed the two numbers disagreed.
 *
 * The detection has to be generic. A rule about one player is worthless the
 * week the sheet changes, so this compares a player only with the players
 * First Seed ranks NEAREST him at his own position.
 */
import { describe, expect, it } from 'vitest';
import {
  detectDataWarnings,
  type AnomalyCandidate,
} from '../../packages/engine/draft/data-anomaly';
import type { Position } from '../../packages/players/types';

/** A position whose rank order and projections agree, as they normally do. */
function coherent(position: Position, count = 20, top = 200, step = 5): AnomalyCandidate[] {
  return Array.from({ length: count }, (_, index) => ({
    playerId: `${position}${index + 1}`,
    position,
    firstSeedRank: index + 1,
    projection: top - index * step,
  }));
}

describe('ranking and projection conflicts', () => {
  it('says nothing about a board where the two agree', () => {
    const warnings = detectDataWarnings([...coherent('RB'), ...coherent('WR', 20, 180, 4)]);
    expect([...warnings.keys()]).toEqual([]);
  });

  it('flags a player projecting far under his own rank neighbours', () => {
    const board = coherent('RB');
    // Ranked tenth, projecting a fifth of what the backs around him project.
    board[9] = { ...board[9], projection: 30 };
    const warnings = detectDataWarnings(board);

    expect([...warnings.keys()]).toEqual(['RB10']);
    const warning = warnings.get('RB10')!;
    expect(warning.code).toBe('ranking_projection_conflict');
    expect(warning.projection).toBe(30);
    expect(warning.shortfallRatio).toBeGreaterThan(2);
    expect(warning.detail).toContain('materially disagree');
    /*
     * Stated neutrally on purpose. A rank legitimately encodes role and risk
     * that a point projection does not, so the gap may be entirely intended -
     * calling the ranking unreliable would decide for the strategist the one
     * question it is better placed to answer.
     */
    expect(warning.detail).toContain('consider both signals');
    expect(warning.detail).not.toMatch(/unreliable|wrong|error/i);
    expect(warning.detail).toContain('neither has been altered');
  });

  it('tolerates ordinary disagreement, which happens constantly', () => {
    const board = coherent('RB');
    // Twenty percent under his neighbours: a difference of opinion about role
    // or risk, not two numbers computed on different bases.
    board[9] = { ...board[9], projection: board[9].projection * 0.8 };
    expect([...detectDataWarnings(board).keys()]).toEqual([]);
  });

  it('compares within position, never across', () => {
    // A kicker projecting less than a quarterback is not a conflict.
    const quarterbacks = coherent('QB', 12, 320, 4);
    const kickers = coherent('K', 12, 130, 2);
    expect([...detectDataWarnings([...quarterbacks, ...kickers]).keys()]).toEqual([]);
  });

  it('compares against rank NEIGHBOURS, not the whole position', () => {
    // The ninetieth back projects far less than the ninth, and should not.
    const deep = Array.from({ length: 60 }, (_, index) => ({
      playerId: `RB${index + 1}`,
      position: 'RB' as Position,
      firstSeedRank: index + 1,
      projection: Math.max(20, 240 - index * 4),
    }));
    expect([...detectDataWarnings(deep).keys()]).toEqual([]);
  });

  it('ignores players First Seed does not rank, and unusable projections', () => {
    const board = coherent('RB');
    board.push({ playerId: 'DEF1', position: 'DEF', firstSeedRank: null, projection: 5 });
    board.push({ playerId: 'RBX', position: 'RB', firstSeedRank: 40, projection: 0 });
    const warnings = detectDataWarnings(board);
    expect(warnings.has('DEF1')).toBe(false);
    expect(warnings.has('RBX')).toBe(false);
  });

  it('stays quiet when a position is too thin for a median to mean anything', () => {
    const thin: AnomalyCandidate[] = [
      { playerId: 'TE1', position: 'TE', firstSeedRank: 1, projection: 140 },
      { playerId: 'TE2', position: 'TE', firstSeedRank: 2, projection: 10 },
      { playerId: 'TE3', position: 'TE', firstSeedRank: 3, projection: 130 },
    ];
    expect([...detectDataWarnings(thin).keys()]).toEqual([]);
  });

  it('reports enough for a reader to judge without looking anything up', () => {
    const board = coherent('RB');
    board[9] = { ...board[9], projection: 30 };
    const warning = detectDataWarnings(board).get('RB10')!;
    expect(warning.neighbourMedianProjection).toBeGreaterThan(100);
    expect(warning.detail).toContain('30');
    expect(warning.detail).toMatch(/rank him 10 at RB/);
  });
});
