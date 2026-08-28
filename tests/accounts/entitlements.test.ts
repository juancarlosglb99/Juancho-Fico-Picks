/**
 * The rules that gate a paid API.
 *
 * These are the tests that matter most in the whole suite, because the failure
 * mode is not a wrong recommendation - it is somebody else's money. Every path
 * is exercised, including the ones that should refuse.
 */
import { describe, expect, it } from 'vitest';
import {
  FREE_ENTITLEMENT,
  NO_CREDITS,
  REFUSAL_MESSAGE,
  creditsHaveExpired,
  creditsRemaining,
  decideAiAccess,
  effectivePlan,
  type CreditBalance,
  type Entitlement,
} from '../../packages/accounts/entitlements';

const NOW = new Date('2026-09-01T12:00:00.000Z');

function entitlement(overrides: Partial<Entitlement> = {}): Entitlement {
  return {
    plan: 'pro',
    status: 'active',
    validFrom: '2026-08-01T00:00:00.000Z',
    validUntil: '2026-12-31T00:00:00.000Z',
    ...overrides,
  };
}

function credits(overrides: Partial<CreditBalance> = {}): CreditBalance {
  return { includedCredits: 5, consumedCredits: 0, resetsAt: null, expiresAt: null, ...overrides };
}

function ask(overrides: Partial<Parameters<typeof decideAiAccess>[0]> = {}) {
  return decideAiAccess({
    signedIn: true,
    entitlement: entitlement(),
    credits: credits(),
    draftAlreadyConsumedCredit: false,
    strategistConfigured: true,
    now: NOW,
    ...overrides,
  });
}

describe('which plan is in force', () => {
  it('falls back to basic with no entitlement at all', () => {
    expect(effectivePlan(null, NOW)).toEqual({ plan: 'basic', expired: false });
  });

  it('honours an active entitlement inside its window', () => {
    expect(effectivePlan(entitlement(), NOW).plan).toBe('pro');
  });

  it('downgrades rather than locking out when it lapses', () => {
    const lapsed = effectivePlan(entitlement({ validUntil: '2026-08-15T00:00:00.000Z' }), NOW);
    // Expiry costs the strategist, never the product.
    expect(lapsed).toEqual({ plan: 'basic', expired: true });
  });

  it('ignores an entitlement that has not started', () => {
    expect(effectivePlan(entitlement({ validFrom: '2026-10-01T00:00:00.000Z' }), NOW).plan).toBe(
      'basic',
    );
  });

  it('ignores a revoked one', () => {
    expect(effectivePlan(entitlement({ status: 'revoked' }), NOW).plan).toBe('basic');
  });

  it('treats an open-ended entitlement as open-ended', () => {
    expect(effectivePlan(entitlement({ validUntil: null }), NOW).plan).toBe('pro');
    expect(effectivePlan(FREE_ENTITLEMENT, NOW).plan).toBe('basic');
  });
});

describe('credits', () => {
  it('never goes below zero', () => {
    expect(creditsRemaining(credits({ includedCredits: 2, consumedCredits: 9 }), NOW)).toBe(0);
  });

  it('is worthless once expired, however many were left', () => {
    const stale = credits({ includedCredits: 10, expiresAt: '2026-08-01T00:00:00.000Z' });
    expect(creditsHaveExpired(stale, NOW)).toBe(true);
    expect(creditsRemaining(stale, NOW)).toBe(0);
  });

  it('is unaffected by an expiry still in the future', () => {
    const live = credits({ expiresAt: '2027-01-01T00:00:00.000Z' });
    expect(creditsHaveExpired(live, NOW)).toBe(false);
    expect(creditsRemaining(live, NOW)).toBe(5);
  });
});

describe('may this user have an AI answer', () => {
  it('allows a Pro user with credits, and charges one', () => {
    expect(ask()).toEqual({
      allowed: true,
      reason: null,
      consumesCredit: true,
      creditsRemaining: 5,
      plan: 'pro',
    });
  });

  it('charges a credit per DRAFT, not per request', () => {
    // The second call of the same draft is already paid for.
    const second = ask({ draftAlreadyConsumedCredit: true });
    expect(second.allowed).toBe(true);
    expect(second.consumesCredit).toBe(false);
  });

  it('still answers a started draft after the last credit is spent', () => {
    const midDraft = ask({
      credits: credits({ includedCredits: 1, consumedCredits: 1 }),
      draftAlreadyConsumedCredit: true,
    });
    // Running out mid-draft would be the worst possible moment to stop.
    expect(midDraft.allowed).toBe(true);
    expect(midDraft.consumesCredit).toBe(false);
  });

  it('refuses a signed-out request before looking at anything else', () => {
    const out = ask({ signedIn: false, entitlement: entitlement({ plan: 'admin' }) });
    expect(out).toMatchObject({ allowed: false, reason: 'not_signed_in', plan: 'basic' });
  });

  it('refuses Basic, and says it is about the plan', () => {
    expect(ask({ entitlement: entitlement({ plan: 'basic' }) })).toMatchObject({
      allowed: false,
      reason: 'plan_does_not_include_ai',
      consumesCredit: false,
    });
    expect(ask({ entitlement: null })).toMatchObject({ reason: 'plan_does_not_include_ai' });
  });

  it('distinguishes an expired entitlement from a plan that never had AI', () => {
    expect(ask({ entitlement: entitlement({ validUntil: '2026-08-15T00:00:00.000Z' }) })).toMatchObject(
      { allowed: false, reason: 'entitlement_expired' },
    );
  });

  it('refuses when the credits are gone, and does not consume one doing so', () => {
    const spent = ask({ credits: credits({ includedCredits: 3, consumedCredits: 3 }) });
    expect(spent).toMatchObject({
      allowed: false,
      reason: 'no_credits_remaining',
      consumesCredit: false,
      creditsRemaining: 0,
    });
  });

  it('separates expired credits from spent ones', () => {
    expect(
      ask({ credits: credits({ expiresAt: '2026-08-01T00:00:00.000Z' }) }),
    ).toMatchObject({ allowed: false, reason: 'credits_expired' });
  });

  it('lets an admin through unmetered, and never charges them', () => {
    const admin = ask({
      entitlement: entitlement({ plan: 'admin', validUntil: null }),
      credits: credits({ includedCredits: 0, consumedCredits: 99 }),
    });
    expect(admin).toEqual({
      allowed: true,
      reason: null,
      consumesCredit: false,
      creditsRemaining: null,
      plan: 'admin',
    });
  });

  it('blames the server, not the user, when there is no key', () => {
    const unconfigured = ask({ strategistConfigured: false });
    expect(unconfigured).toMatchObject({
      allowed: false,
      reason: 'strategist_not_configured',
      consumesCredit: false,
    });
    // And an admin gets the same answer: there is genuinely nothing to call.
    expect(
      ask({ entitlement: entitlement({ plan: 'admin' }), strategistConfigured: false }),
    ).toMatchObject({ reason: 'strategist_not_configured' });
  });

  it('never consumes a credit on any refusal', () => {
    const refusals = [
      ask({ signedIn: false }),
      ask({ entitlement: null }),
      ask({ entitlement: entitlement({ validUntil: '2026-01-01T00:00:00.000Z' }) }),
      ask({ credits: NO_CREDITS }),
      ask({ credits: credits({ expiresAt: '2020-01-01T00:00:00.000Z' }) }),
      ask({ strategistConfigured: false }),
    ];
    for (const refusal of refusals) {
      expect(refusal.allowed).toBe(false);
      expect(refusal.consumesCredit).toBe(false);
      expect(REFUSAL_MESSAGE[refusal.reason!]).toBeTruthy();
    }
  });

  it('has a message for every refusal it can produce', () => {
    const produced = new Set(
      [
        ask({ signedIn: false }),
        ask({ entitlement: null }),
        ask({ entitlement: entitlement({ validUntil: '2026-01-01T00:00:00.000Z' }) }),
        ask({ credits: NO_CREDITS }),
        ask({ credits: credits({ expiresAt: '2020-01-01T00:00:00.000Z' }) }),
        ask({ strategistConfigured: false }),
      ].map((access) => access.reason),
    );
    expect(produced).toEqual(
      new Set([
        'not_signed_in',
        'plan_does_not_include_ai',
        'entitlement_expired',
        'no_credits_remaining',
        'credits_expired',
        'strategist_not_configured',
      ]),
    );
  });
});
