/**
 * Adversarial tests for the response contract.
 *
 * These exist because the schema was already violated in production on the very
 * first evaluation run: the model omitted `decision` despite it being listed as
 * required, the field arrived as `undefined`, and nothing noticed. A tool schema
 * is a request, not a guarantee, and every consumer downstream had been written
 * assuming otherwise.
 *
 * The rule being defended is that a malformed answer produces NO answer - never
 * a partial one, never a coerced one, and never a silently defaulted one.
 */
import { describe, expect, it } from 'vitest';
import { generateDraftRecommendations } from '../../packages/engine/draft/recommendations';
import { resolveStrategistDecision } from '../../packages/engine/strategist/audit';
import { buildDraftBrief } from '../../packages/engine/strategist/brief';
import {
  describeProblems,
  validateStrategistResponse,
} from '../../packages/engine/strategist/anthropic/validate';
import { toAdvice } from '../../packages/engine/strategist/anthropic/client';
import {
  SUBMIT_RECOMMENDATION_TOOL,
  type StrategistResponse,
} from '../../packages/engine/strategist/anthropic/schema';
import type { DraftBrief } from '../../packages/engine/strategist/types';
import type { SleeperDraftPick } from '../../packages/sleeper/types';
import {
  makeContext,
  makeDraft,
  makeLeague,
  makePlayerPool,
  makeProjections,
  makeRoomRankings,
  makeRosters,
} from './fixtures';

const TEAMS = 12;
const players = makePlayerPool(64);
const projections = makeProjections(players);
const roomRankings = makeRoomRankings(projections);

function briefAfter(pickCount: number): DraftBrief {
  const ranked = [...projections].sort((a, b) => b.projection - a.projection);
  const picks: SleeperDraftPick[] = Array.from({ length: pickCount }, (_, index) => {
    const overall = index + 1;
    const round = Math.ceil(overall / TEAMS);
    const pickInRound = ((overall - 1) % TEAMS) + 1;
    const slot = round % 2 === 0 ? TEAMS + 1 - pickInRound : pickInRound;
    return {
      player_id: players.byId.get(ranked[index].playerId)!.externalIds.sleeper!,
      picked_by: `user-${slot}`,
      roster_id: String(slot),
      round,
      draft_slot: slot,
      pick_no: overall,
      metadata: {},
    };
  });
  const league = makeLeague({ teams: TEAMS });
  const draft = makeDraft({ teams: TEAMS });
  const rosters = makeRosters(TEAMS);
  const { context, board } = makeContext({ league, draft, picks, rosters, players });
  const result = generateDraftRecommendations({
    context,
    picks,
    rosters,
    board,
    players,
    projections,
    roomRankings,
  });
  return buildDraftBrief({
    context,
    board,
    picks,
    rosters,
    players,
    result,
    draftId: 'draft-1',
    isMock: true,
  })!;
}

const brief = briefAfter(30);
const boardIds = brief.candidates.map((candidate) => candidate.playerId);
const [first, second, third] = boardIds;

/** A response that should always pass, so every failure below is the one edit. */
function sound(overrides: Partial<Record<keyof StrategistResponse, unknown>> = {}) {
  return {
    recommendedPlayerId: first,
    alternatives: [
      { playerId: second, reason: 'Second best.' },
      { playerId: third, reason: 'Third best.' },
    ],
    confidence: 72,
    decision: 'WAIT',
    strategy: 'Hero RB, filling the last startable receiver slot.',
    reasons: [
      { code: 'starter_need', detail: 'Our second receiver slot is empty.' },
      { code: 'tier_cliff', detail: 'Two players left in this tier.' },
    ],
    strongestAlternative: { playerId: second, why: 'Fills the same slot a round later.' },
    strongestCounterargument: 'He is 84% to survive to our next turn, so waiting may be free.',
    whyRecommendationStillWins: 'The tier behind him empties first, so the slot is the scarce thing.',
    firstSeedDeviationReason: null,
    expectedNextPickPlan: 'Take the better remaining back at our next turn.',
    opponentsThatMatter: [{ rosterId: 4, why: 'They start two backs and need a receiver.' }],
    ...overrides,
  } as Record<string, unknown>;
}

const check = (value: unknown) => validateStrategistResponse(value, boardIds);
const codes = (value: unknown) => check(value).problems.map((problem) => problem.code);
const paths = (value: unknown) => check(value).problems.map((problem) => problem.path);

describe('a sound response', () => {
  it('passes, and passes unchanged', () => {
    const result = check(sound());
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.response).toEqual(sound());
  });

  it('accepts a stated First Seed deviation as well as a null one', () => {
    expect(check(sound({ firstSeedDeviationReason: 'Reaching for the last tier-3 TE.' })).ok).toBe(
      true,
    );
  });

  it('accepts an empty opponent list, which is a real answer', () => {
    expect(check(sound({ opponentsThatMatter: [] })).ok).toBe(true);
  });
});

/* --------------------------------------------------------------- missing fields */

describe('missing fields', () => {
  it('rejects the exact failure seen in production: no decision', () => {
    const { decision, ...withoutDecision } = sound();
    void decision;
    const result = check(withoutDecision);
    expect(result.ok).toBe(false);
    expect(result.response).toBeNull();
    expect(result.problems).toEqual([
      {
        code: 'missing_field',
        path: 'decision',
        message: 'Required field "decision" was not returned.',
      },
    ]);
  });

  it('rejects every required field being absent, one problem each', () => {
    for (const field of Object.keys(sound())) {
      const partial = sound();
      delete partial[field];
      expect(codes(partial), `${field} was allowed to be missing`).toContain('missing_field');
      expect(paths(partial)).toContain(field);
    }
  });

  it('treats an explicit undefined as missing, not as a value', () => {
    expect(codes(sound({ expectedNextPickPlan: undefined }))).toContain('missing_field');
  });

  it('does NOT treat a null First Seed deviation as missing', () => {
    // Null means "no deviation" and is the common case; undefined means the
    // model never considered the question. They must not be conflated.
    expect(check(sound({ firstSeedDeviationReason: null })).ok).toBe(true);
    expect(codes(sound({ firstSeedDeviationReason: undefined }))).toContain('missing_field');
  });

  it('reports every problem at once rather than stopping at the first', () => {
    const broken = sound();
    delete broken.decision;
    delete broken.strategy;
    broken.confidence = 500;
    expect(check(broken).problems.length).toBeGreaterThanOrEqual(3);
  });
});

/* ------------------------------------------------------------------- bad enums */

describe('enums', () => {
  it('rejects a decision outside the two allowed values', () => {
    for (const value of ['draft_now', 'DRAFT', 'MAYBE', '', 'WAIT ', 1, null]) {
      expect(codes(sound({ decision: value })), `accepted ${JSON.stringify(value)}`).toContain(
        'invalid_enum',
      );
    }
  });

  it('accepts exactly the two allowed values', () => {
    expect(check(sound({ decision: 'DRAFT_NOW' })).ok).toBe(true);
    expect(check(sound({ decision: 'WAIT' })).ok).toBe(true);
  });
});

/* -------------------------------------------------------------- bad confidence */

describe('confidence', () => {
  it('rejects anything outside 0-100', () => {
    for (const value of [-1, 101, 1000, -0.5]) {
      expect(codes(sound({ confidence: value })), `accepted ${value}`).toContain('out_of_range');
    }
  });

  it('rejects a non-number, including a numeric string', () => {
    for (const value of ['72', null, {}, [], NaN, Infinity]) {
      expect(codes(sound({ confidence: value })), `accepted ${JSON.stringify(value)}`).toContain(
        'wrong_type',
      );
    }
  });

  it('accepts the boundaries', () => {
    expect(check(sound({ confidence: 0 })).ok).toBe(true);
    expect(check(sound({ confidence: 100 })).ok).toBe(true);
  });

  it('enforces the integer the schema asks for', () => {
    // The published contract and the enforced one have to be the same contract.
    // Whichever is chosen, maintaining two is the actual defect.
    expect(SUBMIT_RECOMMENDATION_TOOL.input_schema.properties.confidence.type).toBe('integer');
    for (const value of [78.5, 0.5, 99.9]) {
      expect(codes(sound({ confidence: value })), `accepted ${value}`).toContain('wrong_type');
    }
  });
});

/* ----------------------------------------------------------- malformed arrays */

describe('malformed arrays', () => {
  it('rejects alternatives that are not an array', () => {
    for (const value of [null, 'two', {}, 2]) {
      expect(codes(sound({ alternatives: value }))).toContain('wrong_type');
    }
  });

  it('rejects the wrong number of alternatives', () => {
    expect(codes(sound({ alternatives: [] }))).toContain('wrong_length');
    expect(codes(sound({ alternatives: [{ playerId: second, reason: 'One.' }] }))).toContain(
      'wrong_length',
    );
    expect(
      codes(
        sound({
          alternatives: [
            { playerId: second, reason: 'One.' },
            { playerId: third, reason: 'Two.' },
            { playerId: boardIds[4], reason: 'Three.' },
          ],
        }),
      ),
    ).toContain('wrong_length');
  });

  it('rejects alternative entries that are not shaped like alternatives', () => {
    expect(codes(sound({ alternatives: [second, third] }))).toContain('wrong_type');
    expect(
      codes(sound({ alternatives: [{ playerId: second }, { playerId: third, reason: 'ok' }] })),
    ).toContain('wrong_type');
    expect(
      paths(sound({ alternatives: [{ playerId: second }, { playerId: third, reason: 'ok' }] })),
    ).toContain('alternatives.0.reason');
  });

  it('rejects too few or too many reasons', () => {
    expect(codes(sound({ reasons: [{ code: 'a', detail: 'b' }] }))).toContain('wrong_length');
    expect(
      codes(sound({ reasons: Array.from({ length: 7 }, () => ({ code: 'a', detail: 'b' })) })),
    ).toContain('wrong_length');
  });

  it('rejects reasons that are missing a code or a detail', () => {
    expect(
      codes(sound({ reasons: [{ code: 'starter_need' }, { code: 'a', detail: 'b' }] })),
    ).toContain('wrong_type');
    expect(
      codes(sound({ reasons: [{ code: '', detail: 'b' }, { code: 'a', detail: 'b' }] })),
    ).toContain('empty_string');
    expect(codes(sound({ reasons: ['starter_need', 'tier_cliff'] }))).toContain('wrong_type');
  });

  it('rejects opponents that are not shaped like opponents', () => {
    expect(codes(sound({ opponentsThatMatter: [{ rosterId: '4', why: 'x' }] }))).toContain(
      'wrong_type',
    );
    expect(codes(sound({ opponentsThatMatter: [{ rosterId: 4.5, why: 'x' }] }))).toContain(
      'wrong_type',
    );
    expect(codes(sound({ opponentsThatMatter: [{ rosterId: 4 }] }))).toContain('wrong_type');
  });
});

/* ------------------------------------------------------ the counterargument */

describe('the strongest counterargument', () => {
  it('cannot be omitted', () => {
    for (const field of [
      'strongestAlternative',
      'strongestCounterargument',
      'whyRecommendationStillWins',
    ]) {
      const partial = sound();
      delete partial[field];
      expect(codes(partial), `${field} was allowed to be missing`).toContain('missing_field');
      expect(paths(partial)).toContain(field);
    }
  });

  it('cannot be empty prose', () => {
    expect(codes(sound({ strongestCounterargument: '   ' }))).toContain('empty_string');
    expect(codes(sound({ whyRecommendationStillWins: '' }))).toContain('empty_string');
    expect(
      codes(sound({ strongestAlternative: { playerId: second, why: '' } })),
    ).toContain('empty_string');
  });

  it('names a real player on the board', () => {
    expect(
      codes(sound({ strongestAlternative: { playerId: 'jfp:invented', why: 'x' } })),
    ).toContain('unknown_player');
    expect(codes(sound({ strongestAlternative: second }))).toContain('wrong_type');
    expect(codes(sound({ strongestAlternative: { why: 'x' } }))).toContain('wrong_type');
  });

  it('rejects naming the recommendation as its own strongest rival', () => {
    // An alternative that is the pick itself answers nothing, and would let the
    // field be satisfied without engaging with anything.
    const result = check(
      sound({ strongestAlternative: { playerId: first, why: 'He is also the best.' } }),
    );
    expect(result.ok).toBe(false);
    expect(result.problems.map((problem) => problem.path)).toContain(
      'strongestAlternative.playerId',
    );
  });
});

/* -------------------------------------------------------- nonexistent players */

describe('players that are not on the board', () => {
  it('rejects an invented primary selection', () => {
    const result = check(sound({ recommendedPlayerId: 'jfp:not-a-real-player' }));
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatchObject({
      code: 'unknown_player',
      path: 'recommendedPlayerId',
    });
  });

  it('rejects a player who was drafted rather than offered', () => {
    const drafted = brief.room.allDraftedPlayerIds[0];
    expect(codes(sound({ recommendedPlayerId: drafted }))).toContain('unknown_player');
  });

  it('rejects an invented alternative even when the primary is sound', () => {
    const result = check(
      sound({
        alternatives: [
          { playerId: second, reason: 'Fine.' },
          { playerId: 'jfp:invented', reason: 'Not fine.' },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.problems.map((problem) => problem.path)).toContain('alternatives.1.playerId');
  });

  it('rejects an empty or non-string player id', () => {
    expect(codes(sound({ recommendedPlayerId: '' }))).toContain('empty_string');
    expect(codes(sound({ recommendedPlayerId: null }))).toContain('wrong_type');
    expect(codes(sound({ recommendedPlayerId: 42 }))).toContain('wrong_type');
  });
});

/* ------------------------------------------------------- partial tool responses */

describe('partial and degenerate tool responses', () => {
  it('rejects a response that is not an object at all', () => {
    for (const value of [null, undefined, 'DRAFT_NOW', 42, [], [sound()]]) {
      const result = check(value);
      expect(result.ok, `accepted ${JSON.stringify(value)}`).toBe(false);
      expect(result.response).toBeNull();
    }
    expect(codes(null)).toEqual(['not_an_object']);
  });

  it('rejects an empty object with one problem per required field', () => {
    const result = check({});
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(
      SUBMIT_RECOMMENDATION_TOOL.input_schema.required.length,
    );
    expect(result.problems.every((problem) => problem.code === 'missing_field')).toBe(true);
  });

  it('rejects a truncated response that stopped mid-object', () => {
    // What a cut-off generation actually looks like: the early fields arrived,
    // the later ones never did.
    expect(
      codes({
        recommendedPlayerId: first,
        alternatives: [{ playerId: second, reason: 'Second best.' }],
        confidence: 72,
      }),
    ).toContain('missing_field');
  });

  it('summarises every problem in one readable line', () => {
    const summary = describeProblems(check({}).problems);
    expect(summary).toContain('decision');
    expect(summary).toContain('recommendedPlayerId');
  });
});

/* ------------------------------------------------------------ failing closed */

describe('failing closed', () => {
  it('records the failure and shows the deterministic pick', () => {
    const malformed = sound();
    delete malformed.decision;
    const validation = check(malformed);
    expect(validation.ok).toBe(false);

    const resolved = resolveStrategistDecision({
      brief,
      // No advice is ever built from a response that failed.
      advice: null,
      responseProblems: validation.problems,
    });

    expect(resolved.outcome).toBe('ai_malformed');
    expect(resolved.final).toMatchObject({
      playerId: brief.deterministic.recommended!.playerId,
      source: 'deterministic',
    });
    expect(resolved.audit.responseProblems).toEqual(validation.problems);
  });

  it('tells a malformed answer apart from no answer at all', () => {
    // Different events needing different responses: one is a contract problem
    // worth investigating, the other is an outage.
    expect(resolveStrategistDecision({ brief, advice: null }).outcome).toBe('ai_unavailable');
    expect(
      resolveStrategistDecision({
        brief,
        advice: null,
        responseProblems: [{ code: 'missing_field', path: 'decision', message: 'x' }],
      }).outcome,
    ).toBe('ai_malformed');
  });

  it('never coerces a missing field into a default', () => {
    /*
     * The temptation is to fill `decision` in from the survival probability and
     * carry on. That produces an answer indistinguishable from a real one, which
     * is exactly the failure mode this whole file exists to prevent.
     */
    const malformed = sound();
    delete malformed.decision;
    const validation = check(malformed);
    expect(validation.response).toBeNull();
    expect(validation.problems).toHaveLength(1);
  });

  it('only builds advice from a response that passed', () => {
    const validation = check(sound({ decision: 'DRAFT_NOW' }));
    expect(validation.ok).toBe(true);
    const advice = toAdvice(validation.response!, brief, 'test-model');
    expect(advice.decision).toBe('DRAFT_NOW');
    expect(advice.confidence).toBeCloseTo(0.72);
  });
});
