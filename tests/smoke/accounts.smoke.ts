/**
 * The account model against a real Postgres.
 *
 * A smoke test rather than a unit test, and deliberately so: the DECISIONS are
 * pure and exhaustively covered in `tests/accounts`, while what needs a real
 * database is the part that cannot be reasoned about - transactions, the
 * partial unique index, and the two properties that protect money.
 *
 *   A credit is spent ONCE per draft, even under concurrent requests.
 *   One user's draft, credits and usage are invisible to another.
 *
 * Runs against `DATABASE_URL` and skips when there is none, so the ordinary
 * suite stays free of infrastructure:
 *
 *     DATABASE_URL=postgres://…/juancho_fico_dev npm run test:smoke
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, databaseConfigured, query } from '../../packages/db/client';
import {
  acquireRequestLease,
  consumeDraftCredit,
  draftUsageTotals,
  ensureAccount,
  globalSpend,
  grantCredits,
  loadAccount,
  readAiControl,
  recordAiUsage,
  releaseRequestLease,
  selectionSpend,
  setAiControl,
  setEntitlement,
  startDraftSession,
} from '../../packages/accounts/repository';
import { decideAiAccess, hasProductAccess } from '../../packages/accounts/entitlements';
import { decideAiLimits, DEFAULT_AI_LIMITS } from '../../packages/accounts/ai-limits';

const configured = databaseConfigured();
const suite = configured ? describe : describe.skip;

/** Users created here and removed afterwards, so a dev database stays clean. */
const ALICE = 'smoke-user-alice';
const BOB = 'smoke-user-bob';

async function makeUser(id: string, email: string) {
  await query(
    `insert into "user" ("id","name","email","emailVerified","createdAt","updatedAt")
     values ($1,$2,$3,false,now(),now())
     on conflict ("id") do nothing`,
    [id, id, email],
  );
  await ensureAccount({ userId: id, displayName: id });
}

suite('the account model, against a real database', () => {
  beforeAll(async () => {
    await query(`delete from "user" where id in ($1, $2)`, [ALICE, BOB]);
    await makeUser(ALICE, 'alice@smoke.test');
    await makeUser(BOB, 'bob@smoke.test');
  });

  afterAll(async () => {
    await query(`delete from "user" where id in ($1, $2)`, [ALICE, BOB]);
    await closePool();
  });

  it('creates a profile and a zero balance on first sight, idempotently', async () => {
    const first = await ensureAccount({ userId: ALICE, displayName: 'Alice' });
    const again = await ensureAccount({ userId: ALICE, displayName: 'Someone Else' });
    expect(first.profile.userId).toBe(ALICE);
    expect(first.credits.includedCredits).toBe(0);
    // Idempotent: a second sign-in must not reset a display name or a balance.
    expect(again.profile.createdAt.getTime()).toBe(first.profile.createdAt.getTime());
    // Registering does not let you in. An admin has to activate the account.
    expect(first.entitlement).toBeNull();
    expect(hasProductAccess(first.entitlement, new Date())).toBe(false);
  });

  it('opens the product the moment an admin activates it', async () => {
    await setEntitlement({ userId: BOB, plan: 'basic', note: 'private beta' });
    const activated = await loadAccount(BOB);
    expect(hasProductAccess(activated!.entitlement, new Date())).toBe(true);
    // Basic is the whole product except the strategist.
    const ai = decideAiAccess({
      signedIn: true,
      entitlement: activated!.entitlement,
      credits: activated!.credits,
      draftAlreadyConsumedCredit: false,
      strategistConfigured: true,
      now: new Date(),
    });
    expect(ai).toMatchObject({ allowed: false, reason: 'plan_does_not_include_ai' });
  });

  it('keeps exactly one active entitlement, however many are granted', async () => {
    await setEntitlement({ userId: ALICE, plan: 'pro' });
    await setEntitlement({ userId: ALICE, plan: 'admin' });
    const account = await loadAccount(ALICE);
    expect(account?.entitlement?.plan).toBe('admin');

    const active = await query<{ count: string }>(
      `select count(*) from entitlement where user_id = $1 and status = 'active'`,
      [ALICE],
    );
    // The partial unique index enforces this; the code does not have to remember.
    expect(Number(active[0].count)).toBe(1);
  });

  it('spends a credit exactly once for a draft, even under a stampede', async () => {
    await setEntitlement({ userId: ALICE, plan: 'pro' });
    await grantCredits({ userId: ALICE, credits: 1 });
    const session = await startDraftSession({
      userId: ALICE,
      sleeperDraftId: 'smoke-draft-1',
      leagueId: null,
      isMock: true,
    });

    /*
     * Six requests at once, which is what a browser reconnecting mid-draft
     * actually looks like. Exactly one may pay.
     */
    const attempts = await Promise.all(
      Array.from({ length: 6 }, () =>
        consumeDraftCredit({ userId: ALICE, sessionId: session.id, unmetered: false }),
      ),
    );
    expect(attempts.filter((attempt) => attempt.consumed)).toHaveLength(1);

    const after = await loadAccount(ALICE);
    expect(after?.credits.consumedCredits).toBe(1);
  });

  it('never charges twice for a draft already paid for', async () => {
    await grantCredits({ userId: ALICE, credits: 5 });
    const before = (await loadAccount(ALICE))!.credits.consumedCredits;
    const session = await startDraftSession({
      userId: ALICE,
      sleeperDraftId: 'smoke-draft-1',
      leagueId: null,
      isMock: true,
    });
    expect(session.aiCreditConsumed).toBe(true);

    const access = decideAiAccess({
      signedIn: true,
      entitlement: (await loadAccount(ALICE))!.entitlement,
      credits: (await loadAccount(ALICE))!.credits,
      draftAlreadyConsumedCredit: session.aiCreditConsumed,
      strategistConfigured: true,
      now: new Date(),
    });
    expect(access.allowed).toBe(true);
    expect(access.consumesCredit).toBe(false);
    expect((await loadAccount(ALICE))!.credits.consumedCredits).toBe(before);
  });

  it('refuses to spend when the balance is gone, rather than going negative', async () => {
    await query(
      `update ai_draft_credits set included_credits = consumed_credits where user_id = $1`,
      [ALICE],
    );
    const session = await startDraftSession({
      userId: ALICE,
      sleeperDraftId: 'smoke-draft-empty',
      leagueId: null,
      isMock: true,
    });
    const attempt = await consumeDraftCredit({
      userId: ALICE,
      sessionId: session.id,
      unmetered: false,
    });
    expect(attempt.consumed).toBe(false);
    const account = await loadAccount(ALICE);
    expect(account!.credits.consumedCredits).toBeLessThanOrEqual(
      account!.credits.includedCredits,
    );
  });

  it('gives an admin an answer without touching the balance, but still logs it', async () => {
    await setEntitlement({ userId: BOB, plan: 'admin' });
    const session = await startDraftSession({
      userId: BOB,
      sleeperDraftId: 'smoke-draft-admin',
      leagueId: null,
      isMock: true,
    });
    await consumeDraftCredit({ userId: BOB, sessionId: session.id, unmetered: true });
    expect((await loadAccount(BOB))!.credits.consumedCredits).toBe(0);

    /*
     * Unmetered is not unmeasured. An admin costs the same money as anybody
     * else and it has to be visible, so the usage row is written regardless of
     * whether a credit was spent.
     */
    await recordAiUsage({
      userId: BOB,
      draftSessionId: session.id,
      model: 'claude-opus-5',
      repairCalls: 0,
      inputTokens: 14_400,
      outputTokens: 520,
      cacheReadTokens: 13_900,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0.23,
      succeeded: true,
    });
    const totals = await draftUsageTotals(session.id);
    expect(totals.calls).toBe(1);
    expect(totals.estimatedCostUsd).toBeCloseTo(0.23, 5);
    expect((await loadAccount(BOB))!.credits.consumedCredits).toBe(0);
  });

  it('keeps one user out of another user’s draft, even with the same draft id', async () => {
    const shared = 'smoke-draft-shared';
    const hers = await startDraftSession({
      userId: ALICE,
      sleeperDraftId: shared,
      leagueId: null,
      isMock: true,
    });
    const his = await startDraftSession({
      userId: BOB,
      sleeperDraftId: shared,
      leagueId: null,
      isMock: true,
    });
    // Same Sleeper draft, two separate sessions. Neither can name the other.
    expect(hers.id).not.toBe(his.id);

    await recordAiUsage({
      userId: ALICE,
      draftSessionId: hers.id,
      model: 'test',
      repairCalls: 0,
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0.25,
      succeeded: true,
    });

    expect((await draftUsageTotals(hers.id)).calls).toBe(1);
    expect((await draftUsageTotals(his.id)).calls).toBe(0);

    // And spending against a session that is not yours is refused outright.
    await expect(
      consumeDraftCredit({ userId: BOB, sessionId: hers.id, unmetered: false }),
    ).rejects.toThrow(/does not belong/i);
  });

  it('totals a draft in the same shape the client renders', async () => {
    const session = await startDraftSession({
      userId: BOB,
      sleeperDraftId: 'smoke-draft-totals',
      leagueId: null,
      isMock: true,
    });
    for (const [cost, ok] of [
      [0.23, true],
      [0.31, true],
      [0, false],
    ] as const) {
      await recordAiUsage({
        userId: BOB,
        draftSessionId: session.id,
        model: 'claude-opus-5',
        repairCalls: ok ? 0 : 1,
        inputTokens: 14_400,
        outputTokens: 520,
        cacheReadTokens: 13_900,
        cacheWriteTokens: 0,
        estimatedCostUsd: cost,
        succeeded: ok,
      });
    }
    const totals = await draftUsageTotals(session.id);
    expect(totals.calls).toBe(3);
    expect(totals.repairCalls).toBe(1);
    expect(totals.failures).toBe(1);
    expect(totals.estimatedCostUsd).toBeCloseTo(0.54, 5);
    expect(totals.inputTokens).toBe(43_200);
  });

  /* ------------------------------------------------- the concurrency ceilings */

  /**
   * The part of the spending limits that cannot be tested without a database.
   *
   * "One strategist request at a time" is a claim about two requests arriving
   * together, and no amount of application code establishes it - the guarantee
   * is a partial unique index, so the test has to be against a real one.
   */
  it('lets exactly one of six simultaneous requests hold the slot', async () => {
    const session = await startDraftSession({
      userId: ALICE,
      sleeperDraftId: 'smoke-draft-lease',
      leagueId: null,
      isMock: true,
    });
    const stampede = await Promise.all(
      Array.from({ length: 6 }, () =>
        acquireRequestLease({
          userId: ALICE,
          draftSessionId: session.id,
          selectionKey: '13',
          leaseSeconds: 120,
        }),
      ),
    );
    expect(stampede.filter((grant) => grant.granted)).toHaveLength(1);

    // And the slot comes back, so the next pick is askable.
    const held = stampede.find((grant) => grant.granted)!;
    await releaseRequestLease(held.leaseId!, 'answered');
    const next = await acquireRequestLease({
      userId: ALICE,
      draftSessionId: session.id,
      selectionKey: '25',
      leaseSeconds: 120,
    });
    expect(next.granted).toBe(true);
    await releaseRequestLease(next.leaseId!, 'answered');
  });

  it('blocks a user across two of their own drafts at once', async () => {
    const first = await startDraftSession({
      userId: BOB,
      sleeperDraftId: 'smoke-draft-two-a',
      leagueId: null,
      isMock: true,
    });
    const second = await startDraftSession({
      userId: BOB,
      sleeperDraftId: 'smoke-draft-two-b',
      leagueId: null,
      isMock: true,
    });
    const held = await acquireRequestLease({
      userId: BOB,
      draftSessionId: first.id,
      selectionKey: '1',
      leaseSeconds: 120,
    });
    expect(held.granted).toBe(true);
    const other = await acquireRequestLease({
      userId: BOB,
      draftSessionId: second.id,
      selectionKey: '1',
      leaseSeconds: 120,
    });
    expect(other.granted).toBe(false);
    await releaseRequestLease(held.leaseId!, 'answered');
  });

  it('does not let one drafter block another in the same league', async () => {
    const shared = 'smoke-draft-league';
    const hers = await startDraftSession({
      userId: ALICE,
      sleeperDraftId: shared,
      leagueId: 'L1',
      isMock: false,
    });
    const his = await startDraftSession({
      userId: BOB,
      sleeperDraftId: shared,
      leagueId: 'L1',
      isMock: false,
    });
    const a = await acquireRequestLease({
      userId: ALICE,
      draftSessionId: hers.id,
      selectionKey: '7',
      leaseSeconds: 120,
    });
    const b = await acquireRequestLease({
      userId: BOB,
      draftSessionId: his.id,
      selectionKey: '7',
      leaseSeconds: 120,
    });
    // Twelve people share one Sleeper draft. Serialising them would be a bug.
    expect(a.granted).toBe(true);
    expect(b.granted).toBe(true);
    await releaseRequestLease(a.leaseId!, 'answered');
    await releaseRequestLease(b.leaseId!, 'answered');
  });

  it('reclaims a slot a dead process left behind', async () => {
    const session = await startDraftSession({
      userId: ALICE,
      sleeperDraftId: 'smoke-draft-expired',
      leagueId: null,
      isMock: true,
    });
    // A lease that expired a second ago: the container that took it is gone.
    const dead = await acquireRequestLease({
      userId: ALICE,
      draftSessionId: session.id,
      selectionKey: '3',
      leaseSeconds: -1,
    });
    expect(dead.granted).toBe(true);
    const next = await acquireRequestLease({
      userId: ALICE,
      draftSessionId: session.id,
      selectionKey: '4',
      leaseSeconds: 120,
    });
    expect(next.granted).toBe(true);
    await releaseRequestLease(next.leaseId!, 'answered');
  });

  it('remembers that a pick was answered, and refuses to ask again', async () => {
    const session = await startDraftSession({
      userId: BOB,
      sleeperDraftId: 'smoke-draft-selection',
      leagueId: null,
      isMock: true,
    });
    const first = await acquireRequestLease({
      userId: BOB,
      draftSessionId: session.id,
      selectionKey: '42',
      leaseSeconds: 120,
    });
    await releaseRequestLease(first.leaseId!, 'answered');

    const spend = await selectionSpend(session.id, '42');
    expect(spend).toEqual({ requests: 1, answered: true });
    expect(
      decideAiLimits({
        control: await readAiControl(),
        killSwitch: false,
        global: { todayUsd: 0, monthUsd: 0 },
        draft: { calls: 1, repairCalls: 0, estimatedCostUsd: 0.2 },
        selection: spend,
        reservedUsd: 1.81,
        limits: DEFAULT_AI_LIMITS,
      }),
    ).toBe('selection_already_answered');

    // A different pick in the same draft is a fair question.
    expect(await selectionSpend(session.id, '43')).toEqual({ requests: 0, answered: false });
  });

  it('lets one failed call be retried, and not a third time', async () => {
    const session = await startDraftSession({
      userId: BOB,
      sleeperDraftId: 'smoke-draft-retry',
      leagueId: null,
      isMock: true,
    });
    for (const attempt of [1, 2]) {
      const lease = await acquireRequestLease({
        userId: BOB,
        draftSessionId: session.id,
        selectionKey: '9',
        leaseSeconds: 120,
      });
      expect(lease.granted, `attempt ${attempt}`).toBe(true);
      await releaseRequestLease(lease.leaseId!, 'failed');
    }
    const spend = await selectionSpend(session.id, '9');
    expect(spend).toEqual({ requests: 2, answered: false });
    expect(
      decideAiLimits({
        control: await readAiControl(),
        killSwitch: false,
        global: { todayUsd: 0, monthUsd: 0 },
        draft: { calls: 2, repairCalls: 0, estimatedCostUsd: 0 },
        selection: spend,
        reservedUsd: 1.81,
        limits: DEFAULT_AI_LIMITS,
      }),
    ).toBe('selection_already_answered');
  });

  /* ------------------------------------------------------ the global switch */

  it('switches every account off in one statement, and back on', async () => {
    const before = await readAiControl();
    try {
      const off = await setAiControl({ enabled: false, disabledReason: 'smoke test' });
      expect(off.enabled).toBe(false);
      expect(off.disabledReason).toBe('smoke test');
      expect(
        decideAiLimits({
          control: off,
          killSwitch: false,
          global: { todayUsd: 0, monthUsd: 0 },
          draft: { calls: 0, repairCalls: 0, estimatedCostUsd: 0 },
          selection: { requests: 0, answered: false },
          reservedUsd: 1.81,
          limits: DEFAULT_AI_LIMITS,
        }),
      ).toBe('ai_disabled');

      const on = await setAiControl({ enabled: true });
      expect(on.enabled).toBe(true);
      expect(on.disabledReason).toBeNull();
    } finally {
      await setAiControl({
        enabled: before.enabled,
        disabledReason: before.disabledReason,
        dailySpendLimitUsd: before.dailySpendLimitUsd,
        monthlySpendLimitUsd: before.monthlySpendLimitUsd,
      });
    }
  });

  it('lowers a spend ceiling without touching the switch, and clears it again', async () => {
    const before = await readAiControl();
    try {
      const lowered = await setAiControl({ dailySpendLimitUsd: 3 });
      expect(lowered.dailySpendLimitUsd).toBe(3);
      expect(lowered.enabled).toBe(before.enabled);

      const cleared = await setAiControl({ dailySpendLimitUsd: null });
      expect(cleared.dailySpendLimitUsd).toBeNull();
    } finally {
      await setAiControl({ dailySpendLimitUsd: before.dailySpendLimitUsd });
    }
  });

  it('sums what the whole deployment has spent, in UTC windows', async () => {
    const session = await startDraftSession({
      userId: ALICE,
      sleeperDraftId: 'smoke-draft-global',
      leagueId: null,
      isMock: true,
    });
    const before = await globalSpend();
    await recordAiUsage({
      userId: ALICE,
      draftSessionId: session.id,
      model: 'claude-opus-5',
      repairCalls: 0,
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0.4,
      succeeded: true,
    });
    const after = await globalSpend();
    expect(after.todayUsd - before.todayUsd).toBeCloseTo(0.4, 5);
    expect(after.monthUsd - before.monthUsd).toBeCloseTo(0.4, 5);
    // A day cannot have cost more than the month that contains it.
    expect(after.todayUsd).toBeLessThanOrEqual(after.monthUsd + 1e-9);
  });
});
