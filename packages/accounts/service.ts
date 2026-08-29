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
import { isRequestedPlan, type RequestedPlan } from '../ui/plans';
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
  creditsRemaining,
  decideAiAccess,
  isAdmin,
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
  setDraftAiRequested,
  setRequestedPlan,
  draftUsageTotals,
  ensureAccount,
  findDraftSession,
  globalSpend,
  readAiControl,
  recordAiUsage,
  recordAttempt,
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
   * Is AI switched on for the deployment at all?
   *
   * Read before the per-draft question, because "we have switched AI off" is a
   * better answer than "you have not switched it on" - and because a drafter
   * should not be invited to spend a credit on a strategist that is not going
   * to answer. The rest of the ceilings are checked further down, after the
   * cheaper gates.
   */
  const control = await readAiControl().catch(() => AI_CONTROL_DEFAULT);
  if (killSwitch || !control.enabled) {
    return {
      allowed: false,
      reason: 'ai_disabled',
      message: REFUSAL_MESSAGE.ai_disabled,
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
   * Has this drafter actually asked for AI on this draft?
   *
   * A credit buys a DRAFT, so this is the gate that stops opening one, watching
   * one, or running a casual mock from spending anything. It sits after the
   * entitlement check - a Basic account should be told their plan does not
   * include the strategist, not that they forgot to switch it on - and before
   * the credit, which is the whole point.
   *
   * Admin is exempt because an admin account has nothing to spend and its badge
   * says the strategist is always on; there would be nothing for the switch to
   * mean.
   */
  const aiEnabledForDraft = access.plan === 'admin' || session.aiRequested;
  if (!aiEnabledForDraft) {
    return {
      allowed: false,
      reason: 'ai_not_enabled_for_draft',
      message: REFUSAL_MESSAGE.ai_not_enabled_for_draft,
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
  /**
   * What this person asked for at signup, if anything.
   *
   * Reported so the pending screen can say "you selected Pro" and the draft
   * room can tell a never-chose from a chose-and-waiting. It confers nothing.
   */
  requestedPlan: RequestedPlan | null;
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
    requestedPlan: null,
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
    requestedPlan: account.profile.requestedPlan,
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

/**
 * Records the shape of every attempt behind one strategist call.
 *
 * Best-effort by construction: an audit row that will not write must never take
 * a working draft down with it, so every failure here is swallowed. The row is
 * what lets "why did the AI stop" be answered from a table rather than from a
 * paid reproduction.
 */
export async function recordAttempts({
  decision,
  boardFingerprint,
  selectionKey,
  model,
  attempts,
}: {
  decision: AiDecision;
  boardFingerprint: string | null;
  selectionKey: string | null;
  model: string | null;
  attempts: {
    problems: { field?: string; path?: string; message?: string }[];
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    } | null;
    latencyMs: number;
    error: string | null;
    diagnostics: {
      stopReason: string | null;
      contentBlockTypes: string[];
      hadToolUse: boolean;
      toolName: string | null;
      toolInputKeyCount: number | null;
      providerErrorStatus: number | null;
      providerErrorType: string | null;
    };
  }[];
  estimatedCostUsd?: number;
}): Promise<void> {
  if (!decision.user || !decision.session) return;
  for (const [index, attempt] of attempts.entries()) {
    const diagnostics = attempt.diagnostics;
    const outcome = diagnostics.providerErrorStatus !== null || (attempt.error && !diagnostics.hadToolUse && diagnostics.contentBlockTypes.length === 0)
      ? 'provider_error'
      : !diagnostics.hadToolUse
        ? 'no_tool_use'
        : attempt.problems.length > 0
          ? 'malformed'
          : 'answered';
    await recordAttempt({
      userId: decision.user.id,
      draftSessionId: decision.session.id,
      boardFingerprint,
      selectionKey,
      attemptIndex: index,
      isRepair: index > 0,
      model,
      outcome,
      stopReason: diagnostics.stopReason,
      contentBlockTypes: diagnostics.contentBlockTypes,
      hadToolUse: diagnostics.hadToolUse,
      toolName: diagnostics.toolName,
      toolInputKeyCount: diagnostics.toolInputKeyCount,
      // Field NAMES only. Which part of the contract broke, never what was in it.
      validationFaults: attempt.problems
        .map((problem) => problem.field ?? problem.path ?? 'unknown')
        .slice(0, 40),
      providerStatus: diagnostics.providerErrorStatus,
      providerErrorType: diagnostics.providerErrorType,
      inputTokens: attempt.usage?.inputTokens ?? 0,
      outputTokens: attempt.usage?.outputTokens ?? 0,
      cacheReadTokens: attempt.usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: attempt.usage?.cacheWriteTokens ?? 0,
      estimatedCostUsd: 0,
      latencyMs: attempt.latencyMs,
    }).catch(() => undefined);
  }
}

/* ---------------------------------------------- what a person asked to buy */

/**
 * Records a plan choice against the signed-in account.
 *
 * The user id comes from the session cookie, never from the body, so there is
 * no parameter through which one person can choose a plan for another. And it
 * grants nothing: the entitlement table is untouched, and an admin still has to
 * activate the account by hand.
 */
export async function requestPlan(
  request: Request,
  plan: unknown,
): Promise<{ ok: boolean; requestedPlan: RequestedPlan | null; error?: string }> {
  if (!accountsEnabled()) return { ok: false, requestedPlan: null, error: 'Accounts are not configured.' };
  if (!isRequestedPlan(plan)) {
    return { ok: false, requestedPlan: null, error: 'Choose either Basic or Pro.' };
  }
  const user = await currentUser(request);
  if (!user) return { ok: false, requestedPlan: null, error: 'Sign in first.' };

  await ensureAccount({ userId: user.id, displayName: user.name });
  await setRequestedPlan({ userId: user.id, plan });
  return { ok: true, requestedPlan: plan };
}

/* ------------------------------------ switching the strategist on for a draft */

export interface DraftAiState {
  ok: boolean;
  /** Whether the strategist will be asked on this draft from now on. */
  aiRequested: boolean;
  /** True once this draft has actually been charged. */
  creditConsumed: boolean;
  creditsRemaining: number | null;
  plan: Plan;
  error?: string;
}

/**
 * The moment a drafter chooses to spend a credit - or takes it back.
 *
 * Nothing is charged here. This sets a flag; `resolveAiAccess` refuses to call
 * anything while that flag is false, and charges on the first request it
 * actually authorises. The two-step matters: a person who switches AI on and
 * then closes the tab has spent nothing, and one who switches it on for a draft
 * their plan does not cover is refused without being billed for finding out.
 *
 * Switching it back off does not refund a draft already paid for. Re-enabling
 * it costs nothing more, which is what "a credit buys a draft" has to mean.
 */
export async function setDraftAi(
  request: Request,
  {
    sleeperDraftId,
    leagueId = null,
    isMock = false,
    enabled,
  }: { sleeperDraftId: string; leagueId?: string | null; isMock?: boolean; enabled: boolean },
): Promise<DraftAiState> {
  const refuse = (error: string): DraftAiState => ({
    ok: false,
    aiRequested: false,
    creditConsumed: false,
    creditsRemaining: null,
    plan: 'basic',
    error,
  });

  if (!accountsEnabled()) return refuse('Accounts are not configured.');
  if (!sleeperDraftId) return refuse('A draft is required.');

  const user = await currentUser(request);
  if (!user) return refuse(REFUSAL_MESSAGE.not_signed_in);

  const account = await ensureAccount({ userId: user.id, displayName: user.name });
  const access = resolveAccess(account.entitlement, new Date());
  if (access.state !== 'active') return refuse(REFUSAL_MESSAGE.not_activated);

  /*
   * Basic never reaches this, and it is refused here as well as in
   * `resolveAiAccess`. Two gates for one rule is deliberate: this one keeps a
   * Basic account from ever setting a flag that implies it has the strategist,
   * and that one is the gate that actually stands in front of the money.
   */
  if (access.plan === 'basic') return refuse(REFUSAL_MESSAGE.plan_does_not_include_ai);

  /*
   * Refuse to switch AI ON while the deployment has it off.
   *
   * No money is at risk either way - `resolveAiAccess` would refuse every
   * request - but a badge reading "AI draft" over a draft that will never get
   * an AI answer is a worse lie than a plain refusal.
   */
  if (enabled) {
    const control = await readAiControl().catch(() => AI_CONTROL_DEFAULT);
    if (killSwitchEngaged() || !control.enabled) {
      return { ...refuse(REFUSAL_MESSAGE.ai_disabled), plan: access.plan };
    }
  }

  const session = await startDraftSession({
    userId: user.id,
    sleeperDraftId,
    leagueId,
    isMock,
  });

  /*
   * Out of credits, and this draft has not been paid for. Refused BEFORE the
   * flag is set, so the draft room does not show "AI draft" to somebody who
   * will be declined on their first pick.
   */
  if (
    enabled &&
    access.plan !== 'admin' &&
    !session.aiCreditConsumed &&
    creditsRemaining(account.credits, new Date()) <= 0
  ) {
    return { ...refuse(REFUSAL_MESSAGE.no_credits_remaining), plan: access.plan, creditsRemaining: 0 };
  }

  const updated = await setDraftAiRequested({
    userId: user.id,
    sessionId: session.id,
    enabled,
  });
  if (!updated) return refuse('That draft does not belong to this account.');

  return {
    ok: true,
    aiRequested: updated.aiRequested,
    creditConsumed: updated.aiCreditConsumed,
    creditsRemaining:
      access.plan === 'admin' ? null : creditsRemaining(account.credits, new Date()),
    plan: access.plan,
  };
}

/**
 * What is already true about this draft. Changes nothing.
 *
 * The screen has to know, on entry, whether the strategist is on and whether
 * this draft has been paid for. It used to ask by calling `setDraftAi` with
 * the value it assumed - which WROTE that assumption, so re-entering a draft
 * you had switched AI on for switched it back off and asked you again. The
 * credit survived, so nothing was lost but the mode; it was still wrong, and a
 * read that writes is the kind of thing that is only wrong until it is
 * expensive.
 */
export async function readDraftAi(
  request: Request,
  { sleeperDraftId, leagueId = null, isMock = false }: {
    sleeperDraftId: string;
    leagueId?: string | null;
    isMock?: boolean;
  },
): Promise<DraftAiState> {
  const blank: DraftAiState = {
    ok: false,
    aiRequested: false,
    creditConsumed: false,
    creditsRemaining: null,
    plan: 'basic',
  };
  if (!accountsEnabled() || !sleeperDraftId) return blank;

  const user = await currentUser(request);
  if (!user) return blank;

  const account = await ensureAccount({ userId: user.id, displayName: user.name });
  const access = resolveAccess(account.entitlement, new Date());
  if (access.state !== 'active' || access.plan === 'basic') {
    return { ...blank, plan: access.plan };
  }

  const session = await startDraftSession({ userId: user.id, sleeperDraftId, leagueId, isMock });
  return {
    ok: true,
    // Admin is always on; there is no switch and nothing to spend.
    aiRequested: access.plan === 'admin' || session.aiRequested,
    creditConsumed: session.aiCreditConsumed,
    creditsRemaining:
      access.plan === 'admin' ? null : creditsRemaining(account.credits, new Date()),
    plan: access.plan,
  };
}

/* --------------------------------------------------------- the admin guard */

/**
 * Is the caller an admin? Decided from the cookie and our own rows, only.
 *
 * There is deliberately no parameter here. Not a header, not a body field, not
 * a query string - nothing an attacker can set. The session cookie identifies
 * the user, the entitlement table says what they are, and an admin whose
 * entitlement has been revoked stops being one the moment the row changes.
 */
export async function requireAdmin(request: Request): Promise<SessionUser | null> {
  if (!accountsEnabled()) return null;
  const user = await currentUser(request);
  if (!user) return null;
  const account = await ensureAccount({ userId: user.id, displayName: user.name });
  const access = resolveAccess(account.entitlement, new Date());
  return isAdmin(access.state, access.plan) ? user : null;
}
