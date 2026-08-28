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
  setEntitlement,
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
          attempts: [{}],
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

  it('calls once for a Pro drafter with credits', async () => {
    const answer = await body(await post(1, nextDraft()));
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
    process.env.AI_KILL_SWITCH = 'true';
    const answer = await body(await post(1, nextDraft()));
    expect(anthropicCalls).toBe(0);
    expect(answer.refusal).toBe('ai_disabled');
  });

  it('never reaches Anthropic while the control row is switched off', async () => {
    await setAiControl({ enabled: false, disabledReason: 'smoke' });
    const answer = await body(await post(1, nextDraft()));
    expect(anthropicCalls).toBe(0);
    expect(answer.refusal).toBe('ai_disabled');
  });

  it('never asks twice about the same pick', async () => {
    const draft = nextDraft();
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
    const draft = nextDraft();
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
    const draft = nextDraft();
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
    await setAiControl({ dailySpendLimitUsd: 0 });
    const answer = await body(await post(1, nextDraft()));
    expect(anthropicCalls).toBe(0);
    expect(answer.refusal).toBe('daily_spend_limit');
  });

  it('lets exactly one of four simultaneous requests through', async () => {
    const draft = nextDraft();
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
    const draft = nextDraft();
    await post(1, draft);
    const held = await query<{ n: string }>(
      `select count(*) as n from ai_request_lease l
         join draft_session s on s.id = l.draft_session_id
        where s.sleeper_draft_id = $1 and l.released_at is null`,
      [draft],
    );
    expect(Number(held[0].n)).toBe(0);
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

  it('holds an admin to the same ceilings as everybody else', async () => {
    await setEntitlement({ userId: USER.id, plan: 'admin' });
    process.env.AI_KILL_SWITCH = 'true';
    const answer = await body(await post(1, nextDraft()));
    expect(anthropicCalls).toBe(0);
    expect(answer.refusal).toBe('ai_disabled');
  });
});
