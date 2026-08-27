/**
 * One repair attempt, and the line it must not cross.
 *
 * Two malformed responses in eight real calls, both dropping the same required
 * field, made this worth building: a contract violation is the one failure a
 * model can reliably fix when it is simply shown what it broke. The rule that
 * matters is what repair is NOT allowed to become - we never fill a missing
 * field in ourselves, because that manufactures an answer indistinguishable
 * from a real one, and a second failure falls back to the deterministic engine
 * exactly as before.
 *
 * The transport is stubbed rather than mocked at the SDK level, so what is
 * under test is the repair loop's own logic: how many requests it makes, what
 * it says in the second one, and what it does with each outcome.
 */
import { describe, expect, it } from 'vitest';
import { generateDraftRecommendations } from '../../packages/engine/draft/recommendations';
import { resolveStrategistDecision } from '../../packages/engine/strategist/audit';
import { buildDraftBrief } from '../../packages/engine/strategist/brief';
import { AnthropicStrategist, repairInstruction } from '../../packages/engine/strategist/anthropic/client';
import { validateStrategistResponse } from '../../packages/engine/strategist/anthropic/validate';
import type { StrategistResponse } from '../../packages/engine/strategist/anthropic/schema';
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
const ids = brief.candidates.map((candidate) => candidate.playerId);
const [first, second, third] = ids;

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
    strongestAlternative: { playerId: second, why: 'Same slot, one round later.' },
    strongestCounterargument: 'He is 84% to survive to our next turn.',
    whyRecommendationStillWins: 'The tier behind him empties first.',
    firstSeedDeviationReason: null,
    expectedNextPickPlan: 'Take the better remaining back at our next turn.',
    opponentsThatMatter: [{ rosterId: 4, why: 'They need a receiver.' }],
    ...overrides,
  } as Record<string, unknown>;
}

/**
 * A strategist whose transport returns scripted tool inputs.
 *
 * Records every request so the test can assert how many were made and what the
 * repair one actually said.
 */
function scriptedStrategist(script: unknown[]) {
  const strategist = new AnthropicStrategist({ apiKey: 'test-key' });
  const requests: { messages: unknown[] }[] = [];
  let call = 0;

  // Replaces only the network boundary; the repair loop under test is untouched.
  (strategist as unknown as { client: unknown }).client = {
    messages: {
      create: async (body: { messages: unknown[] }) => {
        requests.push({ messages: body.messages });
        const input = script[Math.min(call, script.length - 1)];
        call += 1;
        return {
          content: [{ type: 'tool_use', id: `tool-${call}`, name: 'submit_recommendation', input }],
          usage: { input_tokens: 1000, output_tokens: 200 },
        };
      },
    },
  };
  return { strategist, requests };
}

describe('one repair attempt', () => {
  it('does not retry a response that was valid first time', async () => {
    const { strategist, requests } = scriptedStrategist([sound()]);
    const result = await strategist.call(brief);

    expect(requests).toHaveLength(1);
    expect(result.repairAttempted).toBe(false);
    expect(result.attempts).toHaveLength(1);
    expect(result.advice).not.toBeNull();
    expect(result.error).toBeNull();
  });

  it('repairs a response that dropped a required field', async () => {
    // The exact failure seen twice in production: no `decision`.
    const broken = sound();
    delete broken.decision;
    const { strategist, requests } = scriptedStrategist([broken, sound()]);
    const result = await strategist.call(brief);

    expect(requests).toHaveLength(2);
    expect(result.repairAttempted).toBe(true);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0].problems.map((problem) => problem.path)).toEqual(['decision']);
    expect(result.attempts[1].problems).toEqual([]);
    expect(result.advice).not.toBeNull();
    expect(result.error).toBeNull();
    expect(result.response!.decision).toBe('WAIT');
  });

  it('tells the model exactly what was wrong, and to keep its analysis', async () => {
    const broken = sound();
    delete broken.decision;
    const { strategist, requests } = scriptedStrategist([broken, sound()]);
    await strategist.call(brief);

    const repairTurn = requests[1].messages as {
      role: string;
      content: unknown;
    }[];
    // The rejected call is handed back as an assistant turn, then a tool_result.
    expect(repairTurn).toHaveLength(3);
    expect(repairTurn[1].role).toBe('assistant');
    const toolResult = (repairTurn[2].content as { type: string; content: string; is_error: boolean }[])[0];
    expect(toolResult.type).toBe('tool_result');
    expect(toolResult.is_error).toBe(true);
    expect(toolResult.content).toContain('decision');
    expect(toolResult.content).toContain('not in question');
    expect(toolResult.content).toContain('COMPLETE payload');
  });

  it('gives up after the second failure rather than trying again', async () => {
    const broken = sound();
    delete broken.decision;
    const { strategist, requests } = scriptedStrategist([broken, broken, sound()]);
    const result = await strategist.call(brief);

    expect(requests, 'exactly one repair, never a loop').toHaveLength(2);
    expect(result.repairAttempted).toBe(true);
    expect(result.advice).toBeNull();
    expect(result.response).toBeNull();
    expect(result.problems.map((problem) => problem.path)).toEqual(['decision']);
    expect(result.error).toContain('did not satisfy the contract');
  });

  it('falls back to the deterministic pick when repair fails', async () => {
    const broken = sound();
    delete broken.decision;
    const { strategist } = scriptedStrategist([broken, broken]);
    const result = await strategist.call(brief);

    const decision = resolveStrategistDecision({
      brief,
      advice: result.advice,
      responseProblems: result.problems,
      repair: {
        attempted: result.repairAttempted,
        firstAttemptProblems: result.attempts[0].problems,
        succeeded: result.advice !== null,
        attempts: result.attempts.length,
      },
    });

    expect(decision.outcome).toBe('ai_malformed');
    expect(decision.final).toMatchObject({
      playerId: brief.deterministic.recommended!.playerId,
      source: 'deterministic',
    });
    expect(decision.audit.repair).toMatchObject({ attempted: true, succeeded: false, attempts: 2 });
    expect(decision.audit.repair!.firstAttemptProblems[0].path).toBe('decision');
  });

  it('records a successful repair in the audit rather than hiding it', async () => {
    const broken = sound();
    delete broken.decision;
    const { strategist } = scriptedStrategist([broken, sound()]);
    const result = await strategist.call(brief);

    const decision = resolveStrategistDecision({
      brief,
      advice: result.advice,
      responseProblems: result.problems,
      repair: {
        attempted: true,
        firstAttemptProblems: result.attempts[0].problems,
        succeeded: true,
        attempts: 2,
      },
    });
    // The answer stands, but the fact it needed correcting survives.
    expect(decision.outcome).not.toBe('ai_malformed');
    expect(decision.audit.repair).toMatchObject({ attempted: true, succeeded: true });
  });

  it('never fills a missing field in on the model\'s behalf', async () => {
    /*
     * The line repair must not cross. A response that still lacks `decision`
     * after the retry produces NO advice - not advice with a decision we
     * invented from the survival probability, which would be indistinguishable
     * from a real answer.
     */
    const broken = sound();
    delete broken.decision;
    const { strategist } = scriptedStrategist([broken, broken]);
    const result = await strategist.call(brief);

    expect(result.advice).toBeNull();
    expect(result.response).toBeNull();
    expect(result.rawResponse).toMatchObject({ recommendedPlayerId: first });
    expect((result.rawResponse as Record<string, unknown>).decision).toBeUndefined();
  });

  it('sums tokens and latency across both attempts', async () => {
    const broken = sound();
    delete broken.decision;
    const { strategist } = scriptedStrategist([broken, sound()]);
    const result = await strategist.call(brief);

    // Reporting only the successful request would understate what it took.
    expect(result.usage).toEqual({ inputTokens: 2000, outputTokens: 400 });
    expect(result.attempts.every((attempt) => attempt.usage !== null)).toBe(true);
  });

  it('repairs a different kind of fault just as readily', async () => {
    const { strategist, requests } = scriptedStrategist([
      sound({ confidence: 150, decision: 'MAYBE' }),
      sound(),
    ]);
    const result = await strategist.call(brief);

    expect(requests).toHaveLength(2);
    expect(result.attempts[0].problems.map((problem) => problem.code).sort()).toEqual([
      'invalid_enum',
      'out_of_range',
    ]);
    expect(result.advice).not.toBeNull();
  });

  it('does not retry a transport failure, which the model cannot fix', async () => {
    const strategist = new AnthropicStrategist({ apiKey: 'test-key' });
    let calls = 0;
    (strategist as unknown as { client: unknown }).client = {
      messages: {
        create: async () => {
          calls += 1;
          throw new Error('529 overloaded');
        },
      },
    };
    const result = await strategist.call(brief);

    expect(calls, 'a network failure is not a contract failure').toBe(1);
    expect(result.repairAttempted).toBe(false);
    expect(result.advice).toBeNull();
    expect(result.error).toContain('529');
  });
});

describe('the repair instruction', () => {
  it('lists every fault, not just the first', () => {
    const broken = sound();
    delete broken.decision;
    delete broken.strategy;
    const problems = validateStrategistResponse(broken, ids).problems;
    const instruction = repairInstruction(problems);

    expect(problems.length).toBeGreaterThanOrEqual(2);
    for (const problem of problems) expect(instruction).toContain(problem.path);
  });

  it('asks for the whole payload rather than a patch', () => {
    const instruction = repairInstruction([
      { code: 'missing_field', path: 'decision', message: 'x' },
    ]);
    expect(instruction).toContain('COMPLETE payload');
    expect(instruction).toContain('every required field');
    // And protects the analysis, so a formatting slip does not become a
    // different recommendation.
    expect(instruction).toContain('should not change');
  });
});
