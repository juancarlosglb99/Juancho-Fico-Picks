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
 * The plan every signed-in user has by default.
 *
 * Basic is not a degraded state: the deterministic engine and First Seed are the
 * product, and they are unlimited. Pro adds the strategist, which is the only
 * part that costs anything per draft.
 */
export const DEFAULT_PLAN: Plan = 'basic';

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

export type AiRefusal =
  | 'not_signed_in'
  | 'plan_does_not_include_ai'
  | 'entitlement_expired'
  | 'no_credits_remaining'
  | 'credits_expired'
  | 'strategist_not_configured';

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
 * The plan in force right now.
 *
 * An entitlement that has lapsed does not leave the user with nothing; it leaves
 * them on Basic, which is a whole working product. Expiry is a downgrade, never
 * a lockout.
 */
export function effectivePlan(
  entitlement: Entitlement | null,
  now: Date,
): { plan: Plan; expired: boolean } {
  if (!entitlement) return { plan: DEFAULT_PLAN, expired: false };
  if (entitlement.status !== 'active') {
    return { plan: DEFAULT_PLAN, expired: entitlement.status === 'expired' };
  }

  const from = Date.parse(entitlement.validFrom);
  if (Number.isFinite(from) && now.getTime() < from) {
    return { plan: DEFAULT_PLAN, expired: false };
  }

  if (entitlement.validUntil !== null) {
    const until = Date.parse(entitlement.validUntil);
    if (Number.isFinite(until) && now.getTime() >= until) {
      return { plan: DEFAULT_PLAN, expired: true };
    }
  }
  return { plan: entitlement.plan, expired: false };
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

  const { plan, expired } = effectivePlan(entitlement, now);
  const unmetered = UNMETERED_PLANS.has(plan);
  const remaining = unmetered ? null : creditsRemaining(credits, now);

  const refuse = (reason: AiRefusal): AiAccess => ({
    allowed: false,
    reason,
    consumesCredit: false,
    creditsRemaining: remaining,
    plan,
  });

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
  plan_does_not_include_ai:
    'The AI strategist is part of Pro. Your drafts still get the full deterministic engine.',
  entitlement_expired:
    'Your Pro access has ended. Your drafts still get the full deterministic engine.',
  no_credits_remaining:
    'You have used all of your AI drafts. The deterministic engine is unaffected.',
  credits_expired: 'Your AI draft credits have expired.',
  strategist_not_configured: 'The AI strategist is not configured on this server.',
};
