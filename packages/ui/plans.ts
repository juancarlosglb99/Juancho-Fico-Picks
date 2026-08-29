/**
 * What we sell, written once.
 *
 * The pricing page, the pending screen, the badge in the draft room and the
 * admin list all describe the same two products, and the way you find out that
 * four copies have drifted is a customer who was shown one thing and given
 * another. So the catalogue is here, as data, and every screen renders it.
 *
 * NOTHING HERE IS AUTHORISATION. A `RequestedPlan` is what somebody asked for;
 * an `Entitlement` is what an admin granted. They are deliberately different
 * types with different names, because the entire commercial risk in this file
 * is the day the two get conflated and choosing a plan starts granting one.
 *
 * The language is deliberately the customer's, not ours. Nobody is buying API
 * access, tokens or a model - they are buying a draft assistant that either
 * thinks on its own or does not.
 */
import type { Plan } from '../accounts/entitlements';

/** What a person asked for at signup. Never what they were given. */
export type RequestedPlan = 'basic' | 'pro';

export const REQUESTED_PLANS: readonly RequestedPlan[] = ['basic', 'pro'];

export function isRequestedPlan(value: unknown): value is RequestedPlan {
  return value === 'basic' || value === 'pro';
}

export interface PlanOffer {
  id: RequestedPlan;
  /** The tier, as it appears on a badge. */
  label: string;
  /** What the product IS. The thing being bought. */
  productName: string;
  price: string;
  /** One line under the price. */
  summary: string;
  /** Shown above the feature list. */
  featuresHeading: string;
  features: string[];
  cta: string;
  /** AI-assisted drafts included when an admin activates this plan. */
  includedAiDrafts: number;
}

export const BASIC_OFFER: PlanOffer = {
  id: 'basic',
  label: 'Basic',
  productName: 'Smart Draft Assistant',
  price: 'MX$199',
  summary: 'Everything you need to draft well, on every draft you run.',
  featuresHeading: 'Includes',
  features: [
    'Juancho deterministic recommendations',
    'First Seed expert rankings',
    'Live Sleeper draft board',
    'Roster needs',
    'Position drop-offs',
    'Player analysis',
    'Unlimited standard drafts',
  ],
  cta: 'Choose Basic',
  includedAiDrafts: 0,
};

export const PRO_OFFER: PlanOffer = {
  id: 'pro',
  label: 'Pro',
  productName: 'AI Draft Strategist',
  price: 'MX$499',
  summary: 'A second opinion that thinks about your board on its own.',
  featuresHeading: 'Everything in Basic, plus',
  features: [
    'Claude independently analyses your picks',
    'AI confirms or overrides Juancho',
    'Deeper strategic explanations',
    'The strongest counterargument to your pick',
    'AI alternatives',
    'Next-pick planning',
    '3 AI-assisted drafts included',
  ],
  cta: 'Choose Pro',
  includedAiDrafts: 3,
};

export const PLAN_OFFERS: readonly PlanOffer[] = [BASIC_OFFER, PRO_OFFER];

export function offerFor(plan: RequestedPlan): PlanOffer {
  return plan === 'pro' ? PRO_OFFER : BASIC_OFFER;
}

/* ------------------------------------------------------- what a badge says */

export interface PlanBadge {
  /** The short, shouty one. Never the only signal - see `productName`. */
  tier: string;
  productName: string;
  /** A third line, when there is something true to put there. */
  detail: string | null;
}

/**
 * The badge for an ACTIVE account, from the entitlement rather than the request.
 *
 * Admin reads as its own tier on purpose. An admin who cannot tell they are on
 * a support account is an admin who assumes every customer sees what they see.
 */
export function planBadge(plan: Plan, creditsRemaining: number | null): PlanBadge {
  if (plan === 'admin') {
    return { tier: 'Admin', productName: PRO_OFFER.productName, detail: null };
  }
  if (plan === 'pro') {
    return {
      tier: 'Pro',
      productName: PRO_OFFER.productName,
      detail: describeCredits(creditsRemaining),
    };
  }
  return {
    tier: 'Basic',
    productName: BASIC_OFFER.productName,
    detail: 'Juancho + First Seed',
  };
}

/** "3 AI drafts remaining", and the awkward numbers around it. */
export function describeCredits(remaining: number | null): string {
  if (remaining === null) return 'Unlimited AI drafts';
  if (remaining <= 0) return 'No AI drafts remaining';
  return `${remaining} AI draft${remaining === 1 ? '' : 's'} remaining`;
}

/* -------------------------------------------------- waiting for activation */

export interface PendingSummary {
  headline: string;
  /** What they chose, priced, so there is no ambiguity about the amount owed. */
  selection: string | null;
  includes: string | null;
  status: string;
  body: string;
}

/**
 * What somebody sees between registering and being let in.
 *
 * The three facts this screen exists to convey: what you selected, what it
 * includes, and that you are waiting for a person. A sign-in that appears to
 * work and then shows an empty product is far worse than one that says so.
 */
export function pendingSummary({
  requestedPlan,
  revoked,
}: {
  requestedPlan: RequestedPlan | null;
  revoked: boolean;
}): PendingSummary {
  if (revoked) {
    return {
      headline: 'This account no longer has access.',
      selection: null,
      includes: null,
      status: 'Access ended',
      body: 'If you think that is a mistake, reply to whoever invited you.',
    };
  }

  if (!requestedPlan) {
    return {
      headline: 'Choose a plan to get started.',
      selection: null,
      includes: null,
      status: 'No plan selected',
      body: 'Pick the version you want and we will get you set up. Nothing is charged here.',
    };
  }

  const offer = offerFor(requestedPlan);
  return {
    headline: 'Your account is ready, but not switched on yet.',
    selection: `You selected ${offer.label} - ${offer.price}`,
    includes:
      offer.includedAiDrafts > 0
        ? `Includes ${offer.includedAiDrafts} AI-assisted drafts`
        : `Includes the full ${offer.productName}`,
    status: 'Awaiting activation',
    body: 'Payment is arranged privately, and accounts are switched on by hand. Yours exists and is safe - somebody just has to let you in.',
  };
}
