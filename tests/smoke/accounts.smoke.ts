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
  consumeDraftCredit,
  draftUsageTotals,
  ensureAccount,
  grantCredits,
  loadAccount,
  recordAiUsage,
  setEntitlement,
  startDraftSession,
} from '../../packages/accounts/repository';
import { decideAiAccess } from '../../packages/accounts/entitlements';

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
    expect(first.entitlement).toBeNull();
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

  it('gives an admin an answer without touching the balance', async () => {
    await setEntitlement({ userId: BOB, plan: 'admin' });
    const session = await startDraftSession({
      userId: BOB,
      sleeperDraftId: 'smoke-draft-admin',
      leagueId: null,
      isMock: true,
    });
    await consumeDraftCredit({ userId: BOB, sessionId: session.id, unmetered: true });
    const account = await loadAccount(BOB);
    expect(account!.credits.consumedCredits).toBe(0);
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
});
