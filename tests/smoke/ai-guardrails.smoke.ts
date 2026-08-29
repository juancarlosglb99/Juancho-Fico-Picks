/**
 * Does the route ACTUALLY refuse to call Anthropic?
 *
 * Everything else about the ceilings is tested where it is decided: the rules
 * in `tests/accounts/ai-limits.test.ts`, the concurrency in
 * `accounts.smoke.ts`. What is left is the only question that matters to a
 * bill - when a limit is reached, does the HTTP route stop short of the SDK?
 *
 * So the Anthropic client is replaced with a counter and the route is driven
 * through the real database. A limit that is enforced everywhere except the
 * one line that spends money would pass every other test in this repository.
 *
 * NO NETWORK. The transport is a fake and the key is never read, which is the
 * point: a test that proved this by watching a real call would be paying to
 * find out whether it should have paid.
 *
 *     DATABASE_URL=postgres://…/juancho_fico_dev npm run test:smoke
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePool, databaseConfigured, query } from '../../packages/db/client';
import {
  ensureAccount,
  grantCredits,
  setAiControl,
  setDraftAiRequested,
  setEntitlement,
  startDraftSession,
} from '../../packages/accounts/repository';
import { DEFAULT_AI_LIMITS } from '../../packages/accounts/ai-limits';

const configured = databaseConfigured();
const suite = configured ? describe : describe.skip;

const USER = { id: 'smoke-guard-user', name: 'Guard', email: 'guard@smoke.test' };

/** How many times the SDK was reached. The number this whole file is about. */
let anthropicCalls = 0;
/** What the fake pretends each call cost, so a spend cap can be driven. */
let costPerCall = { inputTokens: 8_000, outputTokens: 800 };
/**
 * How long the fake holds the slot.
 *
 * Zero for every test except the concurrency one, which needs the call to still
 * be in flight when the next request arrives - an instant fake finishes and
 * releases its lease before a second request has started, so there would be
 * nothing to collide with.
 */
let callDelayMs = 0;

vi.mock('../../packages/auth/server', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../packages/auth/server')>();
  return {
    ...original,
    // A signed-in caller, without standing up Better Auth and a cookie jar.
    currentUser: async () => ({ id: USER.id, name: USER.name, email: USER.email }),
  };
});

vi.mock('../../packages/engine/strategist/anthropic/client', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../packages/engine/strategist/anthropic/client')>();
  return {
    ...original,
    AnthropicStrategist: class {
      async callWithContext() {
        anthropicCalls += 1;
        if (callDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, callDelayMs));
        }
        return {
          response: null,
          problems: [],
          model: 'claude-opus-5',
          usage: {
            inputTokens: costPerCall.inputTokens,
            outputTokens: costPerCall.outputTokens,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          attempts: [
            {
              problems: [],
              usage: {
                inputTokens: costPerCall.inputTokens,
                outputTokens: costPerCall.outputTokens,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
              },
              latencyMs: 10,
              error: null,
              // The audit path reads this; a fake without it would let the
              // persistence quietly no-op in the one suite that exercises it.
              diagnostics: {
                stopReason: 'tool_use',
                contentBlockTypes: ['tool_use'],
                hadToolUse: true,
                toolName: 'recommend_pick',
                toolInputKeyCount: 12,
                providerErrorStatus: null,
                providerErrorType: null,
              },
            },
          ],
          latencyMs: 10,
          error: null,
        };
      }
    },
  };
});

const { POST } = await import('../../app/api/strategist/route');

function post(pick: number, draftId: string) {
  return POST(
    new Request('https://example.test/api/strategist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        context: { anything: true },
        boardPlayerIds: ['jfp:1'],
        state: {
          draftId,
          picksMade: pick - 1,
          currentOverallPick: pick,
          currentRound: 1,
          boardFingerprint: `fp-${pick}`,
          onTheClockRosterId: 1,
          isOurSelection: true,
        },
        leagueId: null,
        isMock: true,
      }),
    }),
  );
}

async function body(response: Response) {
  return (await response.json()) as { refusal?: string; error?: string; response: unknown };
}

/** A fresh draft id per test, so one test's ceiling is not another's. */
let draftSeq = 0;
const nextDraft = () => `smoke-guard-${(draftSeq += 1)}`;

/**
 * Switch the strategist on for a draft, the way the drafter's own click does.
 *
 * Every test below that expects a call has to do this first, which is the
 * point: a credit buys a draft and nothing is spent until somebody asks.
 */
async function enableAi(sleeperDraftId: string) {
  const session = await startDraftSession({
    userId: USER.id,
    sleeperDraftId,
    leagueId: null,
    isMock: true,
  });
  await setDraftAiRequested({ userId: USER.id, sessionId: session.id, enabled: true });
  return sleeperDraftId;
}

suite('the route, with the SDK replaced by a counter', () => {
  beforeAll(async () => {
    process.env.ANTHROPIC_API_KEY ||= 'not-a-real-key-and-never-sent';
    await query(`delete from "user" where id = $1`, [USER.id]);
    await query(
      `insert into "user" ("id","name","email","emailVerified","createdAt","updatedAt")
       values ($1,$2,$3,false,now(),now())`,
      [USER.id, USER.name, USER.email],
    );
    await ensureAccount({ userId: USER.id, displayName: USER.name });
  });

  afterAll(async () => {
    await query(`delete from "user" where id = $1`, [USER.id]);
    await setAiControl({ enabled: true });
    await closePool();
  });

  beforeEach(async () => {
    anthropicCalls = 0;
    callDelayMs = 0;
    costPerCall = { inputTokens: 8_000, outputTokens: 800 };
    delete process.env.AI_KILL_SWITCH;
    await setAiControl({ enabled: true, dailySpendLimitUsd: null, monthlySpendLimitUsd: null });
    await setEntitlement({ userId: USER.id, plan: 'pro' });
    await grantCredits({ userId: USER.id, credits: 50 });
  });

  afterEach(() => {
    delete process.env.AI_KILL_SWITCH;
  });

  it('calls once for a Pro drafter who switched AI on', async () => {
    const answer = await body(await post(1, await enableAi(nextDraft())));
    expect(anthropicCalls).toBe(1);
    expect(answer.refusal).toBeUndefined();
  });

  it('never reaches Anthropic for a Basic account', async () => {
    await setEntitlement({ userId: USER.id, plan: 'basic' });
    const answer = await body(await post(1, nextDraft()));
    expect(anthropicCalls).toBe(0);
    expect(answer.refusal).toBe('plan_does_not_include_ai');
    expect(answer.response).toBeNull();
  });

  it('never reaches Anthropic for an account nobody has activated', async () => {
    await query(`update entitlement set status = 'revoked' where user_id = $1`, [USER.id]);
    const answer = await body(await post(1, nextDraft()));
    expect(anthropicCalls).toBe(0);
    expect(answer.refusal).toBe('not_activated');
  });

  it('never reaches Anthropic for a Pro account with no credits left', async () => {
    await query(
      `update ai_draft_credits set included_credits = consumed_credits where user_id = $1`,
      [USER.id],
    );
    const answer = await body(await post(1, nextDraft()));
    expect(anthropicCalls).toBe(0);
    expect(answer.refusal).toBe('no_credits_remaining');
  });

  it('never reaches Anthropic while the environment kill switch is pulled', async () => {
    const draft = await enableAi(nextDraft());
    process.env.AI_KILL_SWITCH = 'true';
    const answer = await body(await post(1, draft));
    expect(anthropicCalls).toBe(0);
    expect(answer.refusal).toBe('ai_disabled');
  });

  it('never reaches Anthropic while the control row is switched off', async () => {
    const draft = await enableAi(nextDraft());
    await setAiControl({ enabled: false, disabledReason: 'smoke' });
    const answer = await body(await post(1, draft));
    expect(anthropicCalls).toBe(0);
    expect(answer.refusal).toBe('ai_disabled');
  });

  it('never asks twice about the same pick', async () => {
    const draft = await enableAi(nextDraft());
    await post(7, draft);
    const second = await body(await post(7, draft));
    /*
     * The fake answers with `response: null`, which counts as a failure, so the
     * first retry is allowed and the one after it is not. Two calls, then the
     * pick is closed.
     */
    expect(anthropicCalls).toBe(2);
    void second;
    const third = await body(await post(7, draft));
    expect(anthropicCalls).toBe(2);
    expect(third.refusal).toBe('selection_already_answered');
  });

  it('stops at eighteen calls in one draft, whatever the client does', async () => {
    const draft = await enableAi(nextDraft());
    // Cheap calls, so the spend cap cannot be the thing that stops it.
    costPerCall = { inputTokens: 500, outputTokens: 50 };
    const refusals: (string | undefined)[] = [];
    for (let pick = 1; pick <= 30; pick += 1) {
      refusals.push((await body(await post(pick, draft))).refusal);
    }
    expect(anthropicCalls).toBe(DEFAULT_AI_LIMITS.maxPrimaryCallsPerDraft);
    expect(refusals.at(-1)).toBe('draft_call_limit');
  });

  it('stops on the spend cap before it stops on the call count', async () => {
    const draft = await enableAi(nextDraft());
    // Roughly $0.60 a call on the production model: nine of these is $5.40.
    costPerCall = { inputTokens: 30_000, outputTokens: 2_000 };
    const refusals: (string | undefined)[] = [];
    for (let pick = 1; pick <= 20; pick += 1) {
      refusals.push((await body(await post(pick, draft))).refusal);
    }
    expect(refusals.at(-1)).toBe('draft_spend_limit');
    expect(anthropicCalls).toBeLessThan(DEFAULT_AI_LIMITS.maxPrimaryCallsPerDraft);

    // The cap is HARD: what was actually spent is under five dollars.
    const spent = await query<{ total: string }>(
      `select coalesce(sum(u.estimated_cost_usd), 0) as total
         from ai_usage u
         join draft_session s on s.id = u.draft_session_id
        where s.sleeper_draft_id = $1`,
      [draft],
    );
    expect(Number(spent[0].total)).toBeLessThanOrEqual(DEFAULT_AI_LIMITS.maxDraftSpendUsd);
  });

  it('stops on the deployment-wide daily ceiling', async () => {
    const draft = await enableAi(nextDraft());
    await setAiControl({ dailySpendLimitUsd: 0 });
    const answer = await body(await post(1, draft));
    expect(anthropicCalls).toBe(0);
    expect(answer.refusal).toBe('daily_spend_limit');
  });

  it('lets exactly one of four simultaneous requests through', async () => {
    const draft = await enableAi(nextDraft());
    // The first call holds its slot long enough for the others to arrive, which
    // is the shape a retrying or duplicated client actually produces against a
    // strategist that takes twenty seconds.
    callDelayMs = 150;
    const responses = await Promise.all([
      post(3, draft),
      post(3, draft),
      post(3, draft),
      post(3, draft),
    ]);
    const answers = await Promise.all(responses.map(body));
    expect(anthropicCalls).toBe(1);
    expect(answers.filter((answer) => answer.refusal === 'request_in_flight')).toHaveLength(3);
  });

  it('gives the slot back after every call, so the next pick is askable', async () => {
    const draft = await enableAi(nextDraft());
    await post(1, draft);
    const held = await query<{ n: string }>(
      `select count(*) as n from ai_request_lease l
         join draft_session s on s.id = l.draft_session_id
        where s.sleeper_draft_id = $1 and l.released_at is null`,
      [draft],
    );
    expect(Number(held[0].n)).toBe(0);
  });

  /* ---------------------------------------- the audit the incident needed */

  it('records the SHAPE of every attempt, so a failure needs no paid replay', async () => {
    /*
     * Written after a live mock where the AI failed twelve times and all we had
     * was "output tokens zero, $2.51". A stop reason and a list of content
     * block types would have separated a truncated tool call from a provider
     * rejection; both were thrown away.
     */
    const draft = await enableAi(nextDraft());
    await post(4, draft);

    const rows = await query<{
      outcome: string; stop_reason: string | null; had_tool_use: boolean;
      tool_input_key_count: number | null; content_block_types: string[];
      input_tokens: string; selection_key: string | null;
    }>(
      `select a.outcome, a.stop_reason, a.had_tool_use, a.tool_input_key_count,
              a.content_block_types, a.input_tokens, a.selection_key
         from ai_attempt a join draft_session s on s.id = a.draft_session_id
        where s.sleeper_draft_id = $1`,
      [draft],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].stop_reason).toBe('tool_use');
    expect(rows[0].content_block_types).toEqual(['tool_use']);
    expect(rows[0].had_tool_use).toBe(true);
    expect(rows[0].selection_key).toBe('4');
    expect(Number(rows[0].input_tokens)).toBeGreaterThan(0);
  });

  it('never records prompt text, player names or a key', async () => {
    const draft = await enableAi(nextDraft());
    await post(5, draft);
    const rows = await query<Record<string, unknown>>(
      `select * from ai_attempt a join draft_session s on s.id = a.draft_session_id
        where s.sleeper_draft_id = $1`,
      [draft],
    );
    const dumped = JSON.stringify(rows);
    // Shape, not content. The audit must never become a copy of the draft.
    for (const forbidden of ['sk-ant', 'Current draft state', 'boardPlayerIds', 'jfp:']) {
      expect(dumped, forbidden).not.toContain(forbidden);
    }
  });

  it('logs an admin call without spending a credit', async () => {
    await setEntitlement({ userId: USER.id, plan: 'admin' });
    const before = await query<{ consumed: number }>(
      `select consumed_credits as consumed from ai_draft_credits where user_id = $1`,
      [USER.id],
    );
    const draft = nextDraft();
    await post(1, draft);
    const after = await query<{ consumed: number }>(
      `select consumed_credits as consumed from ai_draft_credits where user_id = $1`,
      [USER.id],
    );
    expect(anthropicCalls).toBe(1);
    expect(after[0].consumed).toBe(before[0].consumed);

    // Unmetered is not unmeasured.
    const logged = await query<{ n: string }>(
      `select count(*) as n from ai_usage u
         join draft_session s on s.id = u.draft_session_id
        where s.sleeper_draft_id = $1`,
      [draft],
    );
    expect(Number(logged[0].n)).toBe(1);
  });

  /* ------------------------------------------- a credit buys a DRAFT, once */

  /**
   * The commercial contract, against a real database.
   *
   * A Pro customer has a fixed number of AI drafts. Every one of these tests is
   * a way that number could be silently wrong.
   */
  async function creditsConsumed(): Promise<number> {
    const rows = await query<{ consumed: number }>(
      `select consumed_credits as consumed from ai_draft_credits where user_id = $1`,
      [USER.id],
    );
    return Number(rows[0].consumed);
  }

  it('does NOT spend a credit when a Pro drafter only opens a draft', async () => {
    const before = await creditsConsumed();
    const answer = await body(await post(1, nextDraft()));
    expect(anthropicCalls).toBe(0);
    expect(answer.refusal).toBe('ai_not_enabled_for_draft');
    // The part that costs money if it is wrong.
    expect(await creditsConsumed()).toBe(before);
  });

  it('does NOT spend a credit merely by switching AI on', async () => {
    const before = await creditsConsumed();
    await enableAi(nextDraft());
    // Enabling is a commitment, not a charge. Closing the tab here costs nothing.
    expect(await creditsConsumed()).toBe(before);
    expect(anthropicCalls).toBe(0);
  });

  it('spends exactly one credit on the first allowed request', async () => {
    const before = await creditsConsumed();
    const draft = await enableAi(nextDraft());
    await post(1, draft);
    expect(anthropicCalls).toBe(1);
    expect(await creditsConsumed()).toBe(before + 1);
  });

  it('spends NOTHING more for the rest of that same draft', async () => {
    const draft = await enableAi(nextDraft());
    await post(1, draft);
    const afterFirst = await creditsConsumed();
    for (const pick of [2, 3, 4, 5]) await post(pick, draft);
    expect(anthropicCalls).toBe(5);
    // Five calls, one credit. This is what "a credit buys a draft" has to mean.
    expect(await creditsConsumed()).toBe(afterFirst);
  });

  it('spends nothing when the same draft is reopened later', async () => {
    const draft = await enableAi(nextDraft());
    await post(1, draft);
    const afterFirst = await creditsConsumed();
    // Re-entering the room: a fresh session row is not created, and the draft
    // is already paid for.
    await enableAi(draft);
    await post(9, draft);
    expect(await creditsConsumed()).toBe(afterFirst);
  });

  it('spends a new credit on a DIFFERENT draft', async () => {
    const first = await enableAi(nextDraft());
    await post(1, first);
    const afterFirst = await creditsConsumed();
    const second = await enableAi(nextDraft());
    await post(1, second);
    expect(await creditsConsumed()).toBe(afterFirst + 1);
  });

  it('does not switch AI back OFF when the draft is reopened', async () => {
    /*
     * Found by visually re-entering a draft during the production QA pass: the
     * screen asked the server what it already knew by POSTing the value it had
     * assumed, which WROTE that assumption. Reopening a draft you had switched
     * AI on for switched it back off and asked you again. The credit survived,
     * so nothing was lost but the mode - and a read that writes is only ever
     * wrong until it is expensive.
     */
    const draft = await enableAi(nextDraft());
    await post(1, draft);

    const { readDraftAi } = await import('../../packages/accounts/service');
    const state = await readDraftAi(new Request('https://example.test/'), {
      sleeperDraftId: draft,
      isMock: true,
    });
    expect(state.aiRequested).toBe(true);
    expect(state.creditConsumed).toBe(true);

    // And the read left the row exactly as it found it.
    const rows = await query<{ ai_requested: boolean }>(
      `select ai_requested from draft_session where sleeper_draft_id = $1`,
      [draft],
    );
    expect(rows[0].ai_requested).toBe(true);
  });

  it('spends nothing for an admin, on any number of drafts', async () => {
    await setEntitlement({ userId: USER.id, plan: 'admin' });
    const before = await creditsConsumed();
    for (const pick of [1, 2, 3]) await post(pick, 'smoke-guard-admin-credits');
    expect(anthropicCalls).toBe(3);
    expect(await creditsConsumed()).toBe(before);
  });

  it('holds an admin to the same ceilings as everybody else', async () => {
    await setEntitlement({ userId: USER.id, plan: 'admin' });
    process.env.AI_KILL_SWITCH = 'true';
    const answer = await body(await post(1, nextDraft()));
    expect(anthropicCalls).toBe(0);
    expect(answer.refusal).toBe('ai_disabled');
  });
});
