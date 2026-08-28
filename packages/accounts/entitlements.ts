/**
 * Who is allowed to spend money, decided without a database in sight.
 *
 * Every rule about plans, expiry and credits lives here as a pure function over
 * plain values. The repository reads rows and hands them in; the route asks one
 * question and gets one answer. That split is not tidiness - it is what lets the
 * rules that gate a paid API be exhaustively tested in a suite that has no
 * Postgres, and it keeps the decision in one readable place instead of spread
 * across three SQL queries and a route handler.
 *
 * The security property this file exists to hold: NOTHING here reads anything
 * the browser sent. A plan arrives from a row in our own database or it does not
 * arrive at all.
 */

export type Plan = 'basic' | 'pro' | 'admin';

export type EntitlementStatus = 'active' | 'expired' | 'revoked';

export interface Entitlement {
  plan: Plan;
  status: EntitlementStatus;
  /** ISO timestamps. Strings rather than Dates so a row round-trips unchanged. */
  validFrom: string;
  validUntil: string | null;
}

export interface CreditBalance {
  includedCredits: number;
  consumedCredits: number;
  /** When the allowance refills, if it ever does. */
  resetsAt: string | null;
  /** After which the remaining allowance is worth nothing. */
  expiresAt: string | null;
}

/**
 * The plan a user has once somebody has activated them.
 *
 * Basic is not a degraded state: the deterministic engine and First Seed are the
 * product, and they are unlimited. Pro adds the strategist, which is the only
 * part that costs anything per draft.
 */
export const DEFAULT_PLAN: Plan = 'basic';

/**
 * Whether this account may use the product at all.
 *
 * The private beta's access control is a person, not a payment: registering
 * creates an account with NO entitlement, and an admin activates it. So
 * "pending" is a real state and it is not the same as Basic - a pending account
 * has no product, and a Basic one has all of it except the strategist.
 *
 * `expired` is deliberately NOT pending. Once somebody has been activated,
 * letting a subscription lapse costs them the strategist, not the draft board.
 * Revocation is the deliberate act that takes access away, and it does.
 */
export type AccessState = 'pending' | 'active' | 'revoked';

export interface Access {
  state: AccessState;
  plan: Plan;
  /** True when an active entitlement has run past its end date. */
  expired: boolean;
}

export const FREE_ENTITLEMENT: Entitlement = {
  plan: DEFAULT_PLAN,
  status: 'active',
  validFrom: '1970-01-01T00:00:00.000Z',
  validUntil: null,
};

export const NO_CREDITS: CreditBalance = {
  includedCredits: 0,
  consumedCredits: 0,
  resetsAt: null,
  expiresAt: null,
};

/** Plans that include the AI strategist at all. */
const AI_PLANS: ReadonlySet<Plan> = new Set<Plan>(['pro', 'admin']);

/** Plans that ignore the credit allowance. Development and support only. */
const UNMETERED_PLANS: ReadonlySet<Plan> = new Set<Plan>(['admin']);

/**
 * Every reason the strategist is not called.
 *
 * Two families, and they are worth keeping distinguishable. The first seven are
 * about WHO is asking - a plan, a balance, a session - and a person can usually
 * do something about them. The rest are about HOW MUCH has already been spent,
 * they are enforced by `ai-limits.ts` from our own usage rows, and there is
 * nothing for the person to do except keep drafting, which still works.
 */
export type AiRefusal =
  | 'not_signed_in'
  | 'not_activated'
  | 'plan_does_not_include_ai'
  | 'entitlement_expired'
  | 'no_credits_remaining'
  | 'credits_expired'
  | 'strategist_not_configured'
  /** The deployment-wide kill switch, from the environment or the control row. */
  | 'ai_disabled'
  /** This user, or this draft, already has a call in flight. */
  | 'request_in_flight'
  /** This pick has had its answer, or its allowed retries. */
  | 'selection_already_answered'
  | 'draft_call_limit'
  | 'draft_repair_limit'
  | 'draft_spend_limit'
  | 'daily_spend_limit'
  | 'monthly_spend_limit';

export interface AiAccess {
  allowed: boolean;
  /** Null when allowed. Never a message - the screen owns the wording. */
  reason: AiRefusal | null;
  /**
   * Whether granting this should spend a credit.
   *
   * False for an admin, and false for a draft that has already spent one - a
   * credit buys a DRAFT, not a request, so the second call of the same draft is
   * already paid for.
   */
  consumesCredit: boolean;
  /** Null means unmetered. */
  creditsRemaining: number | null;
  /** The plan actually in force, after expiry is applied. */
  plan: Plan;
}

/**
 * What this account may do right now.
 *
 * Three outcomes, and the distinction between the first two is the whole beta:
 * an account nobody has activated has no product, an activated one has all of
 * it, and what its plan is decides only whether the strategist is included.
 */
export function resolveAccess(entitlement: Entitlement | null, now: Date): Access {
  // Registered, not yet activated by an admin.
  if (!entitlement) return { state: 'pending', plan: DEFAULT_PLAN, expired: false };

  // Taken away deliberately. This is the one that locks somebody out.
  if (entitlement.status === 'revoked') {
    return { state: 'revoked', plan: DEFAULT_PLAN, expired: false };
  }

  // Lapsed on its own. A downgrade, not a lockout.
  if (entitlement.status === 'expired') {
    return { state: 'active', plan: DEFAULT_PLAN, expired: true };
  }

  const from = Date.parse(entitlement.validFrom);
  if (Number.isFinite(from) && now.getTime() < from) {
    // Granted, but not started yet: nothing to use.
    return { state: 'pending', plan: DEFAULT_PLAN, expired: false };
  }

  if (entitlement.validUntil !== null) {
    const until = Date.parse(entitlement.validUntil);
    if (Number.isFinite(until) && now.getTime() >= until) {
      return { state: 'active', plan: DEFAULT_PLAN, expired: true };
    }
  }
  return { state: 'active', plan: entitlement.plan, expired: false };
}

/** Whether the draft room opens at all. */
export function hasProductAccess(entitlement: Entitlement | null, now: Date): boolean {
  return resolveAccess(entitlement, now).state === 'active';
}

/**
 * The plan in force right now.
 *
 * Kept as a narrower view over `resolveAccess` for the callers that only care
 * which features are included.
 */
export function effectivePlan(
  entitlement: Entitlement | null,
  now: Date,
): { plan: Plan; expired: boolean } {
  const access = resolveAccess(entitlement, now);
  return { plan: access.plan, expired: access.expired };
}

/** Never negative, and zero once the allowance has expired. */
export function creditsRemaining(balance: CreditBalance, now: Date): number {
  if (balance.expiresAt !== null) {
    const expires = Date.parse(balance.expiresAt);
    if (Number.isFinite(expires) && now.getTime() >= expires) return 0;
  }
  return Math.max(0, balance.includedCredits - balance.consumedCredits);
}

export function creditsHaveExpired(balance: CreditBalance, now: Date): boolean {
  if (balance.expiresAt === null) return false;
  const expires = Date.parse(balance.expiresAt);
  return Number.isFinite(expires) && now.getTime() >= expires;
}

/**
 * May this user have an AI answer, and should it cost them a credit?
 *
 * Order matters, and it is ordered by what the person can do about it. Being
 * signed out is theirs to fix; a plan that does not include AI is theirs to fix;
 * a strategist the server has not been given a key for is nobody's but ours, so
 * it is checked last and never blamed on the user's plan.
 */
export function decideAiAccess({
  signedIn,
  entitlement,
  credits,
  draftAlreadyConsumedCredit,
  strategistConfigured,
  now,
}: {
  signedIn: boolean;
  entitlement: Entitlement | null;
  credits: CreditBalance;
  /** True when this draft has already spent its credit. */
  draftAlreadyConsumedCredit: boolean;
  strategistConfigured: boolean;
  now: Date;
}): AiAccess {
  if (!signedIn) {
    return {
      allowed: false,
      reason: 'not_signed_in',
      consumesCredit: false,
      creditsRemaining: null,
      plan: DEFAULT_PLAN,
    };
  }

  const access = resolveAccess(entitlement, now);
  const { plan, expired } = access;
  const unmetered = UNMETERED_PLANS.has(plan);
  const remaining = unmetered ? null : creditsRemaining(credits, now);

  const refuse = (reason: AiRefusal): AiAccess => ({
    allowed: false,
    reason,
    consumesCredit: false,
    creditsRemaining: remaining,
    plan,
  });

  // Not activated at all: a different answer from "your plan does not include
  // it", because there is nothing to upgrade from yet.
  if (access.state !== 'active') return refuse('not_activated');

  if (!AI_PLANS.has(plan)) {
    return refuse(expired ? 'entitlement_expired' : 'plan_does_not_include_ai');
  }

  if (!unmetered && !draftAlreadyConsumedCredit) {
    if (creditsHaveExpired(credits, now)) return refuse('credits_expired');
    if ((remaining ?? 0) <= 0) return refuse('no_credits_remaining');
  }

  if (!strategistConfigured) return refuse('strategist_not_configured');

  return {
    allowed: true,
    reason: null,
    consumesCredit: !unmetered && !draftAlreadyConsumedCredit,
    creditsRemaining: remaining,
    plan,
  };
}

/** What a screen says about a refusal. Kept beside the rules so they cannot drift. */
export const REFUSAL_MESSAGE: Record<AiRefusal, string> = {
  not_signed_in: 'Sign in to use the AI strategist.',
  not_activated: 'Your account is waiting to be activated.',
  plan_does_not_include_ai:
    'The AI strategist is part of Pro. Your drafts still get the full deterministic engine.',
  entitlement_expired:
    'Your Pro access has ended. Your drafts still get the full deterministic engine.',
  no_credits_remaining:
    'You have used all of your AI drafts. The deterministic engine is unaffected.',
  credits_expired: 'Your AI draft credits have expired.',
  strategist_not_configured: 'The AI strategist is not configured on this server.',
  ai_disabled: 'The AI strategist is switched off right now. Your draft is unaffected.',
  request_in_flight: 'The strategist is already working on a pick for you.',
  selection_already_answered: 'The strategist has already answered this pick.',
  draft_call_limit:
    'This draft has used its AI allowance. The deterministic engine carries the rest of it.',
  draft_repair_limit:
    'This draft has used its AI allowance. The deterministic engine carries the rest of it.',
  draft_spend_limit:
    'This draft has used its AI allowance. The deterministic engine carries the rest of it.',
  daily_spend_limit: 'AI is paused for today. Your draft is unaffected.',
  monthly_spend_limit: 'AI is paused for this month. Your draft is unaffected.',
};

/**
 * Refusals that mean a ceiling was reached rather than a plan was wrong.
 *
 * Worth separating because the screen should say different things: a plan
 * problem is an invitation to upgrade, and a ceiling is a statement of fact
 * that no action of the user's will change today.
 */
export const LIMIT_REFUSALS: ReadonlySet<AiRefusal> = new Set<AiRefusal>([
  'ai_disabled',
  'request_in_flight',
  'selection_already_answered',
  'draft_call_limit',
  'draft_repair_limit',
  'draft_spend_limit',
  'daily_spend_limit',
  'monthly_spend_limit',
]);
