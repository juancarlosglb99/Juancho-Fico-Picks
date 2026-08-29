/**
 * The vocabulary a drafter reads. Most of these are about what it refuses to
 * say: no tier numbers, no floating-point artefacts, and no survival figure
 * where nothing was estimated.
 */
import { describe, expect, it } from 'vitest';
import {
  describeAvailability,
  describeConfidence,
  describeEdge,
  describeNeed,
  describePoints,
  describeStrength,
  describeTierDepth,
} from '../../packages/ui/plain-language';

describe('position depth, without the word tier', () => {
  it('says how many comparable players remain', () => {
    const deep = describeTierDepth({
      position: 'WR',
      playersRemaining: 8,
      gapAfterTier: 3,
      weStartOne: true,
    });
    expect(deep.supply).toBe('8 similarly rated WRs remain');
    expect(deep.dropOff).toBe('No major drop-off yet');
    expect(deep.advice).toBe('No need to rush');
    expect(deep.urgency).toBe('no_rush');
    // Nothing a reader has to decode.
    expect(JSON.stringify(deep)).not.toMatch(/tier/i);
  });

  it('calls a real cliff a cliff', () => {
    const cliff = describeTierDepth({
      position: 'TE',
      playersRemaining: 1,
      gapAfterTier: 40,
      weStartOne: true,
    });
    expect(cliff.supply).toBe('Only 1 TE of this quality left');
    expect(cliff.dropOff).toBe('Big quality drop after him');
    expect(cliff.advice).toBe('Last good chance at this position');
    expect(cliff.urgency).toBe('last_chance');
  });

  it('separates a thin group from a steep one', () => {
    // Two left but the board barely falls: no reason to reach.
    expect(
      describeTierDepth({ position: 'RB', playersRemaining: 2, gapAfterTier: 2, weStartOne: true })
        .urgency,
    ).toBe('no_rush');
    // Two left and a real drop behind them: worth acting on.
    expect(
      describeTierDepth({ position: 'RB', playersRemaining: 2, gapAfterTier: 12, weStartOne: true })
        .advice,
    ).toBe('Consider taking one now');
  });

  it('is not a last chance when the group is very likely to survive', () => {
    const thin = {
      position: 'QB' as const,
      playersRemaining: 1,
      gapAfterTier: 40,
      weStartOne: true,
    };
    // Scarce, and steep - but the simulation says one is almost certainly there.
    const safe = describeTierDepth({ ...thin, chanceOneRemains: 99 });
    expect(safe.urgency).toBe('no_rush');
    expect(safe.advice).toBe('Should still be there at your turn');
    // The scarcity itself is still reported; only the urgency changed.
    expect(safe.supply).toBe('Only 1 QB of this quality left');
    expect(safe.dropOff).toBe('Big quality drop after him');

    // The same group, about to be taken.
    const gone = describeTierDepth({ ...thin, chanceOneRemains: 20 });
    expect(gone.urgency).toBe('last_chance');
    expect(gone.advice).toBe('Last good chance at this position');

    // And in between.
    expect(describeTierDepth({ ...thin, chanceOneRemains: 60 }).advice).toBe(
      'Consider taking one now',
    );
  });

  it('admits when the drop-off is unknown', () => {
    const unknown = describeTierDepth({
      position: 'QB',
      playersRemaining: 5,
      gapAfterTier: null,
      weStartOne: false,
    });
    expect(unknown.dropOff).toBe('Drop-off unknown');
  });
});

describe('availability', () => {
  it('reads as a sentence, not a metric', () => {
    expect(
      describeAvailability({ probability: 47, modeled: true, picksUntilTurn: 11 }),
    ).toBe("47% chance he's still available at your next pick");
  });

  it('never turns a missing estimate into a number', () => {
    expect(describeAvailability({ probability: null, modeled: false, picksUntilTurn: 11 })).toBe(
      'Not enough simulation data',
    );
    // The dangerous case: a default value carried alongside `modeled: false`.
    expect(describeAvailability({ probability: 100, modeled: false, picksUntilTurn: 11 })).toBe(
      'Not enough simulation data',
    );
  });

  it('handles the two certainties', () => {
    expect(describeAvailability({ probability: 100, modeled: true, picksUntilTurn: 0 })).toContain(
      'pick again immediately',
    );
    expect(
      describeAvailability({ probability: null, modeled: false, picksUntilTurn: null }),
    ).toBe('This is your last selection');
  });
});

describe('numbers a person can read', () => {
  it('turns a share into a word', () => {
    expect(describeStrength(0.8999999, 1)).toBe('High');
    expect(describeStrength(50, 100)).toBe('Medium');
    expect(describeStrength(2, 100)).toBe('Low');
    expect(describeStrength(1, 0)).toBe('Low');
  });

  it('rounds points rather than showing a float', () => {
    expect(describePoints(344.29999)).toBe('344');
    expect(describePoints(null)).toBe('—');
    expect(describePoints(Number.NaN)).toBe('—');
  });

  it('describes a roster need without a decimal', () => {
    expect(describeNeed('critical', 2.9)).toBe('You need 3 starters here');
    expect(describeNeed('high', 1.0)).toBe('You still need a starter here');
    expect(describeNeed('high', 0.2)).toBe('Thin here');
    expect(describeNeed('medium', 0)).toBe('Could use depth');
    expect(describeNeed('none', 0)).toBe('Well covered');
    for (const level of ['critical', 'high', 'medium', 'low', 'none'] as const) {
      expect(describeNeed(level, 2.9)).not.toMatch(/\./);
    }
  });

  it('grades an edge in words', () => {
    expect(describeEdge(2)).toBe('slight');
    expect(describeEdge(-12)).toBe('moderate');
    expect(describeEdge(40)).toBe('strong');
  });

  it('capitalises a confidence', () => {
    expect(describeConfidence('high')).toBe('High');
    expect(describeConfidence('low')).toBe('Low');
  });
});
