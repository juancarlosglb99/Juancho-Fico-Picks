/**
 * Everything about the Anthropic strategist that can be checked without paying.
 *
 * The call itself is exercised by `npm run strategist:eval`, which is kept out
 * of this suite on purpose. What is testable here is the wiring around it, and
 * that is where the quiet failures live: a response mapped onto the wrong
 * fields, a cache that returns yesterday's answer after the playbook changed, a
 * server-only module that finds its way into a browser bundle.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateDraftRecommendations } from '../../packages/engine/draft/recommendations';
import { resolveStrategistDecision } from '../../packages/engine/strategist/audit';
import { buildDraftBrief } from '../../packages/engine/strategist/brief';
import { buildStrategistPromptContext } from '../../packages/engine/strategist/prompt-context';
import { cacheKey } from '../../packages/engine/strategist/anthropic/cache';
import {
  DEFAULT_STRATEGIST_MODEL,
  resolveStrategistModel,
  strategistFingerprint,
  toAdvice,
} from '../../packages/engine/strategist/anthropic/client';
import {
  PLAYBOOK_VERSION,
  STRATEGIST_SYSTEM_PROMPT,
} from '../../packages/engine/strategist/anthropic/playbook';
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

const respond = (
  playerId: string,
  overrides: Partial<StrategistResponse> = {},
): StrategistResponse => ({
  recommendedPlayerId: playerId,
  alternatives: [
    { playerId: 'alt-1', reason: 'Second best.' },
    { playerId: 'alt-2', reason: 'Third best.' },
  ],
  confidence: 72,
  urgency: 'likely_to_return',
  strategy: 'Hero RB, now filling the last startable receiver slot.',
  reasons: [
    { code: 'starter_need', detail: 'Our second receiver slot is empty.' },
    { code: 'tier_cliff', detail: 'Two players left in this tier.' },
  ],
  strongestAlternativePlayerId: 'alt-1',
  strongestAlternativeWhy: 'Fills the same slot a round later.',
  strongestCounterargument: 'He is 84% to survive to our next turn.',
  whyRecommendationStillWins: 'The tier behind him empties first, so the slot is the scarce thing.',
  firstSeedDeviationReason: null,
  expectedNextPickPlan: 'Take the better of the two remaining backs at our next turn.',
  opponentsThatMatter: [{ rosterId: 4, why: 'They start two backs and need a receiver.' }],
  ...overrides,
});

/* ------------------------------------------------------------- the playbook */

describe('the strategist playbook', () => {
  it('teaches the principles this project was burned by', () => {
    const prompt = STRATEGIST_SYSTEM_PROMPT;

    // Nine quarterbacks in a one-quarterback league is the failure that started
    // all of this. If this paragraph is ever deleted, the test should fail.
    expect(prompt).toMatch(/one-quarterback league a quarterback's raw fantasy point total is NOT comparable/i);
    expect(prompt).toMatch(/SUPERFLEX/);

    // Not a chatbot, and not a maximiser of any single column.
    expect(prompt).toMatch(/not a chat assistant/i);
    expect(prompt).toMatch(/NONE of them is the answer/);

    // First Seed is a prior, Juancho is evidence.
    expect(prompt).toMatch(/strong prior, not a draft order/i);
    expect(prompt).toMatch(/Juancho is evidence, not truth/i);

    // The archetypes, as tools rather than rules.
    for (const build of ['Robust RB', 'Hero RB', 'Zero RB', 'WR-heavy', 'Early QB', 'Early TE']) {
      expect(prompt, `playbook lost ${build}`).toContain(build);
    }
    expect(prompt).toMatch(/never as rules to follow/i);
    expect(prompt).toMatch(/Pivot when the board demands it/i);

    // Turn structure, runs, cliffs, starters versus depth.
    expect(prompt).toMatch(/REASON TO WAIT/);
    expect(prompt).toMatch(/tier cliff/i);
    expect(prompt).toMatch(/not a licence to draft for need at any price/i);

    // And never inventing news while there is none.
    expect(prompt).toMatch(/Never invent injuries/i);
  });

  it('asks for all nine lines of reasoning', () => {
    for (const step of [
      'Best available',
      'Our roster',
      'Opportunity cost',
      'Opponents before us',
      'Survival',
      'Tier cliffs',
      'First Seed',
      'Juancho',
      'The sequence',
    ]) {
      expect(STRATEGIST_SYSTEM_PROMPT, `reasoning step "${step}" missing`).toContain(`**${step}**`);
    }
  });

  it('states the hard constraints the guardrails will enforce', () => {
    expect(STRATEGIST_SYSTEM_PROMPT).toMatch(/already on any roster shown/i);
    expect(STRATEGIST_SYSTEM_PROMPT).toMatch(/usableCapacity/);
    expect(STRATEGIST_SYSTEM_PROMPT).toMatch(/unfillable/);
  });
});

/* ------------------------------------------------------------- the contract */

describe('the response contract', () => {
  it('requires every field the decision is judged on', () => {
    expect(SUBMIT_RECOMMENDATION_TOOL.input_schema.required).toEqual([
      'recommendedPlayerId',
      'alternatives',
      'confidence',
      'urgency',
      'strategy',
      'reasons',
      // Forced self-criticism: the model must name the fact that most threatens
      // its own answer and engage with it, rather than only its supporting case.
      'strongestAlternativePlayerId',
      'strongestAlternativeWhy',
      'strongestCounterargument',
      'whyRecommendationStillWins',
      'firstSeedDeviationReason',
      'expectedNextPickPlan',
      'opponentsThatMatter',
    ]);
  });

  it('asks for exactly two alternatives and a bounded confidence', () => {
    const properties = SUBMIT_RECOMMENDATION_TOOL.input_schema.properties as Record<
      string,
      { minItems?: number; maxItems?: number; minimum?: number; maximum?: number; enum?: string[] }
    >;
    expect(properties.alternatives.minItems).toBe(2);
    expect(properties.alternatives.maxItems).toBe(2);
    expect(properties.confidence.minimum).toBe(0);
    expect(properties.confidence.maximum).toBe(100);
    expect(properties.urgency.enum).toEqual([
      'must_take_now',
      'likely_to_return',
      'neutral',
    ]);
  });
});

/* -------------------------------------------------------------- the mapping */

describe('turning a response into advice', () => {
  it('normalises confidence and keeps the structured reasons', () => {
    const brief = briefAfter(30);
    const target = brief.candidates[4];
    const advice = toAdvice(respond(target.playerId), brief, 'test-model');

    expect(advice.primary.playerId).toBe(target.playerId);
    // The model answers 0-100; everything downstream works in 0-1.
    expect(advice.confidence).toBeCloseTo(0.72);
    expect(advice.primary.confidence).toBeCloseTo(0.72);
    expect(advice.primary.reasonCodes).toEqual(['starter_need', 'tier_cliff']);
    expect(advice.urgency).toBe('likely_to_return');
    expect(advice.strategy).toContain('Hero RB');
    expect(advice.expectedNextPickPlan).toBeTruthy();
    expect(advice.opponentsThatMatter).toHaveLength(1);
    expect(advice.model).toBe('test-model');
  });

  it('stamps the board state from the brief, never from the model', () => {
    const brief = briefAfter(30);
    const advice = toAdvice(respond(brief.candidates[0].playerId), brief, 'test-model');
    // What it was looking at is a fact about which brief we handed it, not
    // something it should be able to assert.
    expect(advice.state).toEqual(brief.state);
  });

  it('still loses to the guardrails when the model invents a player', () => {
    const brief = briefAfter(30);
    const advice = toAdvice(respond('jfp:does-not-exist'), brief, 'test-model');
    const decision = resolveStrategistDecision({ brief, advice });

    expect(decision.outcome).toBe('ai_rejected');
    expect(decision.audit.guardrail!.violations[0].code).toBe('not_in_candidate_pool');
    expect(decision.final!.source).toBe('deterministic');
  });
});

/* ---------------------------------------------------------------- the cache */

describe('the answer cache', () => {
  it('keys on the exact payload, so a changed board is a miss', () => {
    const first = buildStrategistPromptContext(briefAfter(30));
    const second = buildStrategistPromptContext(briefAfter(31));
    expect(cacheKey({ model: 'm', payload: first })).toBe(
      cacheKey({ model: 'm', payload: first }),
    );
    expect(cacheKey({ model: 'm', payload: first })).not.toBe(
      cacheKey({ model: 'm', payload: second }),
    );
  });

  it('keys on the model too, so two models never share an answer', () => {
    const payload = buildStrategistPromptContext(briefAfter(30));
    expect(cacheKey({ model: 'a', payload })).not.toBe(cacheKey({ model: 'b', payload }));
  });

  it('identifies the playbook, so editing it invalidates stored answers', () => {
    expect(strategistFingerprint('m')).toBe(`m/playbook-v${PLAYBOOK_VERSION}`);
  });
});

/* ------------------------------------------------------------ the boundaries */

describe('the server-only boundary', () => {
  it('resolves the model from the environment, not from a call site', () => {
    const previous = process.env.JUANCHO_STRATEGIST_MODEL;
    try {
      delete process.env.JUANCHO_STRATEGIST_MODEL;
      expect(resolveStrategistModel()).toBe(DEFAULT_STRATEGIST_MODEL);
      process.env.JUANCHO_STRATEGIST_MODEL = 'some-other-model';
      expect(resolveStrategistModel()).toBe('some-other-model');
      // An explicit argument still wins, for tests and one-off comparisons.
      expect(resolveStrategistModel('pinned')).toBe('pinned');
    } finally {
      if (previous === undefined) delete process.env.JUANCHO_STRATEGIST_MODEL;
      else process.env.JUANCHO_STRATEGIST_MODEL = previous;
    }
  });

  it('keeps the API client out of the general strategist barrel', () => {
    /*
     * The general barrel is safe to import anywhere. The Anthropic one reads
     * ANTHROPIC_API_KEY and pulls in the SDK, so re-exporting it here would put
     * a server secret one careless import away from a browser bundle.
     */
    const barrel = readFileSync('packages/engine/strategist/index.ts', 'utf8');
    expect(barrel).not.toMatch(/from '\.\/anthropic/);
  });
});
