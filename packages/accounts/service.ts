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
import { inspectRuntime } from '../config/runtime';
import { databaseConfigured } from '../db/client';
import {
  decideAiLimits,
  effectiveLimits,
  killSwitchEngaged,
  reservedCallCostUsd,
  AI_CONTROL_DEFAULT,
  type AiLimits,
} from './ai-limits';
import {
  decideAiAccess,
  REFUSAL_MESSAGE,
  resolveAccess,
  type AccessState,
  type AiAccess,
  type AiRefusal,
  type Plan,
} from './entitlements';
import {
  acquireRequestLease,
  consumeDraftCredit,
  draftUsageTotals,
  ensureAccount,
  findDraftSession,
  globalSpend,
  readAiControl,
  recordAiUsage,
  releaseRequestLease,
  selectionSpend,
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
  /**
   * The slot this request is holding, which the route MUST give back.
   *
   * Null on every refusal and on the unmetered local path. Non-null means a row
   * exists that is blocking this user's next request until it is released or it
   * expires, so the route releases it in a `finally` rather than on the happy
   * path.
   */
  leaseId: string | null;
  /** The ceilings that were applied, for the health and admin views. */
  limits: AiLimits | null;
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

/**
 * May this request reach Anthropic, and what does granting it commit us to?
 *
 * Three gates in a fixed order, and the order is the security property.
 *
 *   1. IS SPENDING ON AT ALL - the kill switch, checked before anything about
 *      the caller, because a switch that some plans could ignore is not one.
 *   2. IS THIS PERSON ALLOWED - plan, activation, credits. Basic never passes
 *      this gate, so a Basic account cannot reach Anthropic by any route.
 *   3. HAS ENOUGH BEEN SPENT - the per-draft, per-selection and deployment
 *      ceilings, counted from our own `ai_usage` and lease rows.
 *
 * Only then is the one concurrent slot taken, and only then is the credit
 * spent. Every refusal returns `allowed: false` and nothing else happens: no
 * lease, no credit, no call. The deterministic engine is already on screen and
 * stays there, which is what makes these limits safe to set as low as they are.
 */
export async function resolveAiAccess({
  request,
  sleeperDraftId,
  selectionKey,
  model,
  promptTokens = 0,
  leagueId = null,
  isMock = false,
  strategistConfigured,
  now = new Date(),
}: {
  request: Request;
  sleeperDraftId: string;
  /**
   * Which selection of ours this is - the overall pick number.
   *
   * Client-supplied, and it is the ONLY input here that is. A caller that lies
   * about it defeats the per-selection dedupe and nothing else; the per-draft
   * call, repair and spend ceilings are counted from our own rows.
   */
  selectionKey: string;
  /** The model that would be called, so worst-case cost can be reserved. */
  model: string;
  /**
   * Roughly how large this particular prompt is.
   *
   * Only ever raises the reservation, never lowers it, so a caller that gets
   * it wrong or omits it cannot weaken the spend cap.
   */
  promptTokens?: number;
  leagueId?: string | null;
  isMock?: boolean;
  strategistConfigured: boolean;
  now?: Date;
}): Promise<AiDecision> {
  const killSwitch = killSwitchEngaged();

  if (!accountsEnabled()) {
    /*
     * No database, so no plan, no balance and nowhere to count what has been
     * spent. The local override is the only way through, and the kill switch
     * still closes it - the switch is a property of the deployment, not of the
     * accounting.
     */
    const allowed = !killSwitch && unmeteredLocalAccess() && strategistConfigured;
    const reason: AiRefusal | null = allowed
      ? null
      : killSwitch
        ? 'ai_disabled'
        : strategistConfigured
          ? 'not_signed_in'
          : 'strategist_not_configured';
    return {
      allowed,
      reason,
      message: allowed
        ? null
        : reason === 'not_signed_in'
          ? 'Accounts are not configured on this server.'
          : REFUSAL_MESSAGE[reason as AiRefusal],
      plan: allowed ? 'admin' : 'basic',
      creditsRemaining: null,
      user: null,
      session: null,
      usage: null,
      leaseId: null,
      limits: null,
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
      leaseId: null,
      limits: null,
    };
  }

  /*
   * The ceilings. Deliberately AFTER the entitlement check and BEFORE anything
   * that costs money or takes a lock, so a refusal here leaves the database in
   * exactly the state it was in.
   *
   * An admin is exempt from paying, not from the ceilings: a runaway loop on a
   * support account spends real money in exactly the same way.
   */
  const control = await readAiControl().catch(() => AI_CONTROL_DEFAULT);
  const limits = effectiveLimits(process.env, control);
  const reservedUsd = reservedCallCostUsd(model, { inputTokens: promptTokens });
  const [global, selection] = await Promise.all([
    globalSpend(),
    selectionSpend(session.id, selectionKey),
  ]);

  const limitRefusal = decideAiLimits({
    control,
    killSwitch,
    global,
    draft: usage,
    selection,
    reservedUsd,
    limits,
  });
  if (limitRefusal) {
    return {
      allowed: false,
      reason: limitRefusal,
      message: REFUSAL_MESSAGE[limitRefusal],
      plan: access.plan,
      creditsRemaining: access.creditsRemaining,
      user,
      session,
      usage,
      leaseId: null,
      limits,
    };
  }

  /*
   * One request at a time, per user and per draft.
   *
   * The database decides this, not the code above it: two requests arriving
   * together both read an empty lease table, and only one of them can insert.
   */
  const lease = await acquireRequestLease({
    userId: user.id,
    draftSessionId: session.id,
    selectionKey,
    leaseSeconds: limits.leaseSeconds,
  });
  if (!lease.granted || lease.leaseId === null) {
    return {
      allowed: false,
      reason: 'request_in_flight',
      message: REFUSAL_MESSAGE.request_in_flight,
      plan: access.plan,
      creditsRemaining: access.creditsRemaining,
      user,
      session,
      usage,
      leaseId: null,
      limits,
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
    }).catch(async (error) => {
      // The slot goes back before the error does, or a failed charge would
      // block this user's next attempt for the whole lease window.
      await releaseRequestLease(lease.leaseId as string, 'failed').catch(() => {});
      throw error;
    });
    if (!spend.consumed) {
      await releaseRequestLease(lease.leaseId, 'abandoned').catch(() => {});
      return {
        allowed: false,
        reason: 'no_credits_remaining',
        message: REFUSAL_MESSAGE.no_credits_remaining,
        plan: access.plan,
        creditsRemaining: 0,
        user,
        session,
        usage,
        leaseId: null,
        limits,
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
      leaseId: lease.leaseId,
      limits,
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
    leaseId: lease.leaseId,
    limits,
  };
}

/**
 * Gives back the one concurrent slot this request was holding.
 *
 * Safe to call with a decision that never took one, and safe to call twice, so
 * the route can put it in a `finally` without reasoning about which path it
 * arrived by. Never throws: failing to release a lease costs the user a two
 * minute wait, and turning that into a 500 would cost them the answer they
 * already paid for.
 */
export async function releaseAiRequest(
  decision: AiDecision,
  outcome: 'answered' | 'failed' | 'abandoned',
): Promise<void> {
  if (!decision.leaseId) return;
  await releaseRequestLease(decision.leaseId, outcome).catch(() => {});
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
export interface AccountSummary {
  signedIn: boolean;
  user: SessionUser | null;
  plan: Plan;
  /**
   * Whether an admin has activated this account.
   *
   * The private beta's gate. `pending` means registered and waiting; the draft
   * room does not open until somebody says so.
   */
  access: AccessState;
  creditsRemaining: number | null;
  accountsEnabled: boolean;
  /**
   * Fatal configuration problems, in production only.
   *
   * The container refuses to start when this is non-empty, so seeing it here
   * means something started the server past its own preflight. The screen says
   * so rather than serving an application with no authorisation behind it.
   */
  misconfigured: string[];
}

export async function accountSummary(request: Request): Promise<AccountSummary> {
  const runtime = inspectRuntime();
  const signedOut = (accountsOn: boolean): AccountSummary => ({
    signedIn: false,
    user: null,
    plan: 'basic',
    access: 'pending',
    creditsRemaining: null,
    accountsEnabled: accountsOn,
    misconfigured: runtime.problems,
  });

  if (!accountsEnabled()) return signedOut(false);
  const user = await currentUser(request);
  if (!user) return signedOut(true);

  const account = await ensureAccount({ userId: user.id, displayName: user.name });
  const now = new Date();
  const access = resolveAccess(account.entitlement, now);
  const ai = decideAiAccess({
    signedIn: true,
    entitlement: account.entitlement,
    credits: account.credits,
    draftAlreadyConsumedCredit: false,
    strategistConfigured: true,
    now,
  });
  return {
    signedIn: true,
    user,
    plan: access.plan,
    access: access.state,
    creditsRemaining: ai.creditsRemaining,
    accountsEnabled: true,
    misconfigured: runtime.problems,
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
    leaseId: null,
    limits: null,
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
