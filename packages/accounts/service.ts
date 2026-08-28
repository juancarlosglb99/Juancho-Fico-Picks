/**
 * The one question the strategist route asks, and the one act that follows it.
 *
 * Everything an untrusted caller could influence stops here. The route hands in
 * a `Request` and a draft id; this resolves the session from the signed cookie,
 * reads the plan and the balance from our own database, asks the pure rules for
 * an answer, and - only if the answer is yes - spends the credit.
 *
 * There is deliberately no parameter through which a caller can assert a plan,
 * a credit count, or another user's draft. A draft session is looked up BY the
 * authenticated user id, so asking about somebody else's draft creates a fresh
 * empty session of your own rather than reading theirs.
 */
import { currentUser, type SessionUser } from '../auth/server';
import { databaseConfigured } from '../db/client';
import {
  decideAiAccess,
  REFUSAL_MESSAGE,
  type AiAccess,
  type AiRefusal,
  type Plan,
} from './entitlements';
import {
  consumeDraftCredit,
  draftUsageTotals,
  ensureAccount,
  findDraftSession,
  recordAiUsage,
  startDraftSession,
  type DraftSession,
  type DraftUsageTotals,
} from './repository';

export interface AiDecision {
  allowed: boolean;
  reason: AiRefusal | null;
  message: string | null;
  plan: Plan;
  creditsRemaining: number | null;
  user: SessionUser | null;
  session: DraftSession | null;
  /** The running total for this draft, from the database. */
  usage: DraftUsageTotals | null;
}

/**
 * Whether accounts are switched on at all.
 *
 * With no database this product still works: the deterministic engine, First
 * Seed and the whole draft room are unchanged. What is unavailable is anything
 * that costs money, which is the correct thing to lose.
 */
export function accountsEnabled(): boolean {
  return databaseConfigured();
}

/**
 * In a development environment with no database, who is the caller?
 *
 * Nobody, and that is the point: without somewhere to record a plan and a
 * balance, there is no way to authorise spending, so the strategist is off.
 * `AI_ALLOW_WITHOUT_ACCOUNTS` exists for local work against a real key and is
 * refused outright in production, because it is precisely the switch an
 * attacker would want.
 */
function unmeteredLocalAccess(): boolean {
  return (
    process.env.NODE_ENV !== 'production' &&
    process.env.AI_ALLOW_WITHOUT_ACCOUNTS === 'true'
  );
}

export async function resolveAiAccess({
  request,
  sleeperDraftId,
  leagueId = null,
  isMock = false,
  strategistConfigured,
  now = new Date(),
}: {
  request: Request;
  sleeperDraftId: string;
  leagueId?: string | null;
  isMock?: boolean;
  strategistConfigured: boolean;
  now?: Date;
}): Promise<AiDecision> {
  if (!accountsEnabled()) {
    const allowed = unmeteredLocalAccess() && strategistConfigured;
    return {
      allowed,
      reason: allowed ? null : strategistConfigured ? 'not_signed_in' : 'strategist_not_configured',
      message: allowed
        ? null
        : strategistConfigured
          ? 'Accounts are not configured on this server.'
          : REFUSAL_MESSAGE.strategist_not_configured,
      plan: allowed ? 'admin' : 'basic',
      creditsRemaining: null,
      user: null,
      session: null,
      usage: null,
    };
  }

  const user = await currentUser(request);
  if (!user) {
    return refusal('not_signed_in', 'basic', null, null, null);
  }

  const account = await ensureAccount({ userId: user.id, displayName: user.name });
  const session = await startDraftSession({
    userId: user.id,
    sleeperDraftId,
    leagueId,
    isMock,
  });

  const access: AiAccess = decideAiAccess({
    signedIn: true,
    entitlement: account.entitlement,
    credits: account.credits,
    draftAlreadyConsumedCredit: session.aiCreditConsumed,
    strategistConfigured,
    now,
  });

  const usage = await draftUsageTotals(session.id);

  if (!access.allowed) {
    return {
      allowed: false,
      reason: access.reason,
      message: access.reason ? REFUSAL_MESSAGE[access.reason] : null,
      plan: access.plan,
      creditsRemaining: access.creditsRemaining,
      user,
      session,
      usage,
    };
  }

  /*
   * The decision said yes; now make it true. The check inside the transaction
   * is the one that counts - between reading the balance above and this line, a
   * concurrent request could have spent the last credit.
   */
  if (access.consumesCredit) {
    const spend = await consumeDraftCredit({
      userId: user.id,
      sessionId: session.id,
      unmetered: false,
    });
    if (!spend.consumed) {
      return {
        allowed: false,
        reason: 'no_credits_remaining',
        message: REFUSAL_MESSAGE.no_credits_remaining,
        plan: access.plan,
        creditsRemaining: 0,
        user,
        session,
        usage,
      };
    }
    return {
      allowed: true,
      reason: null,
      message: null,
      plan: access.plan,
      creditsRemaining: spend.creditsRemaining,
      user,
      session: { ...session, aiEnabled: true, aiCreditConsumed: true },
      usage,
    };
  }

  // Unmetered, or a draft that has already been paid for.
  await consumeDraftCredit({ userId: user.id, sessionId: session.id, unmetered: true });
  return {
    allowed: true,
    reason: null,
    message: null,
    plan: access.plan,
    creditsRemaining: access.creditsRemaining,
    user,
    session: { ...session, aiEnabled: true },
    usage,
  };
}

/** Records what a call cost, and returns the draft's new running total. */
export async function recordCall({
  decision,
  model,
  attempts,
  usage,
  estimatedCostUsd,
  succeeded,
}: {
  decision: AiDecision;
  model: string | null;
  attempts: number;
  usage: {
    inputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
  } | null;
  estimatedCostUsd: number;
  succeeded: boolean;
}): Promise<DraftUsageTotals | null> {
  if (!decision.user || !decision.session) return null;
  await recordAiUsage({
    userId: decision.user.id,
    draftSessionId: decision.session.id,
    model,
    // Attempts beyond the first are repairs, billed like any other call.
    repairCalls: Math.max(0, attempts - 1),
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    cacheReadTokens: usage?.cacheReadTokens ?? 0,
    cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
    estimatedCostUsd,
    succeeded,
  });
  return draftUsageTotals(decision.session.id);
}

/** What the account screen shows. Never derived from anything the client sent. */
export async function accountSummary(request: Request): Promise<{
  signedIn: boolean;
  user: SessionUser | null;
  plan: Plan;
  creditsRemaining: number | null;
  accountsEnabled: boolean;
} | null> {
  if (!accountsEnabled()) {
    return { signedIn: false, user: null, plan: 'basic', creditsRemaining: null, accountsEnabled: false };
  }
  const user = await currentUser(request);
  if (!user) {
    return { signedIn: false, user: null, plan: 'basic', creditsRemaining: null, accountsEnabled: true };
  }
  const account = await ensureAccount({ userId: user.id, displayName: user.name });
  const access = decideAiAccess({
    signedIn: true,
    entitlement: account.entitlement,
    credits: account.credits,
    draftAlreadyConsumedCredit: false,
    strategistConfigured: true,
    now: new Date(),
  });
  return {
    signedIn: true,
    user,
    plan: access.plan,
    creditsRemaining: access.creditsRemaining,
    accountsEnabled: true,
  };
}

function refusal(
  reason: AiRefusal,
  plan: Plan,
  creditsRemaining: number | null,
  session: DraftSession | null,
  usage: DraftUsageTotals | null,
): AiDecision {
  return {
    allowed: false,
    reason,
    message: REFUSAL_MESSAGE[reason],
    plan,
    creditsRemaining,
    user: null,
    session,
    usage,
  };
}

export async function markDraftComplete(request: Request, sleeperDraftId: string): Promise<void> {
  if (!accountsEnabled()) return;
  const user = await currentUser(request);
  if (!user) return;
  const session = await findDraftSession(user.id, sleeperDraftId);
  if (session && !session.completedAt) {
    const { completeDraftSession } = await import('./repository');
    await completeDraftSession(session.id);
  }
}
