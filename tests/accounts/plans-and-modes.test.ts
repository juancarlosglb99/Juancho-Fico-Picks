/**
 * What a customer is offered, what they are told they have, and what it costs.
 *
 * The commercial failure modes this file exists to prevent, in order of how
 * expensive they would be:
 *
 *   Signing up silently means Basic.        A person pays for nothing.
 *   Choosing a plan grants it.              Everybody gets Pro for free.
 *   Opening a draft spends a credit.        A Pro customer's three drafts
 *                                           disappear into mocks they never
 *                                           asked to spend them on.
 *   The draft room does not say which mode. Somebody pays for AI and cannot
 *                                           tell whether they are getting it.
 */
import { describe, expect, it } from 'vitest';
import {
  BASIC_OFFER,
  PLAN_OFFERS,
  PRO_OFFER,
  describeCredits,
  isRequestedPlan,
  offerFor,
  pendingSummary,
  planBadge,
} from '../../packages/ui/plans';
import { cardBanner, creditPrompt, resolveDraftMode } from '../../packages/ui/draft-mode';
import { screenForUrl } from '../../packages/ui/auth-flow';
import type { RecommendationCardState } from '../../packages/ui/recommendation';

describe('what is on sale', () => {
  it('is shown before anybody can sign up', () => {
    // The whole of priority zero, in one assertion.
    expect(screenForUrl('').screen).toBe('plans');
  });

  it('prices both products and names what they are', () => {
    expect(BASIC_OFFER.price).toBe('MX$199');
    expect(BASIC_OFFER.productName).toBe('Smart Draft Assistant');
    expect(PRO_OFFER.price).toBe('MX$499');
    expect(PRO_OFFER.productName).toBe('AI Draft Strategist');
    expect(PRO_OFFER.includedAiDrafts).toBe(3);
    expect(BASIC_OFFER.includedAiDrafts).toBe(0);
  });

  it('never talks about APIs, tokens, models or providers', () => {
    /*
     * The customer is buying a drafting experience. Any of these words on a
     * pricing page means somebody has described the plumbing instead.
     */
    const forbidden = /\b(api|token|tokens|model|anthropic|opus|sonnet|endpoint|backend)\b/i;
    for (const offer of PLAN_OFFERS) {
      const prose = [offer.productName, offer.summary, offer.cta, ...offer.features].join(' ');
      expect(prose, offer.id).not.toMatch(forbidden);
    }
  });

  it('only accepts the two plans a person can actually choose', () => {
    expect(isRequestedPlan('basic')).toBe(true);
    expect(isRequestedPlan('pro')).toBe(true);
    // Admin is granted, never requested. This is the gap an attacker would aim at.
    expect(isRequestedPlan('admin')).toBe(false);
    expect(isRequestedPlan('')).toBe(false);
    expect(isRequestedPlan(null)).toBe(false);
    expect(isRequestedPlan({ plan: 'pro' })).toBe(false);
  });
});

describe('waiting for activation', () => {
  it('says what was selected, what it includes, and that a person is next', () => {
    const summary = pendingSummary({ requestedPlan: 'pro', revoked: false });
    expect(summary.selection).toContain('Pro');
    expect(summary.selection).toContain('MX$499');
    expect(summary.includes).toContain('3 AI-assisted drafts');
    expect(summary.status).toBe('Awaiting activation');
  });

  it('offers the choice to somebody who never made one', () => {
    const summary = pendingSummary({ requestedPlan: null, revoked: false });
    expect(summary.status).toBe('No plan selected');
    expect(summary.selection).toBeNull();
  });

  it('reads differently when access was taken away', () => {
    const summary = pendingSummary({ requestedPlan: 'pro', revoked: true });
    expect(summary.status).toBe('Access ended');
    // No pricing on a revoked account: it is not an invitation to pay again.
    expect(summary.selection).toBeNull();
  });
});

describe('the badge on an active account', () => {
  it('tells Basic what it has, without calling it a lesser thing', () => {
    const badge = planBadge('basic', 0);
    expect(badge.tier).toBe('Basic');
    expect(badge.productName).toBe('Smart Draft Assistant');
    expect(badge.detail).toBe('Juancho + First Seed');
  });

  it('tells Pro how many AI drafts are left', () => {
    expect(planBadge('pro', 3).detail).toBe('3 AI drafts remaining');
    expect(planBadge('pro', 1).detail).toBe('1 AI draft remaining');
    expect(planBadge('pro', 0).detail).toBe('No AI drafts remaining');
  });

  it('marks admin as its own thing', () => {
    const badge = planBadge('admin', null);
    expect(badge.tier).toBe('Admin');
    expect(badge.detail).toBeNull();
  });

  it('never renders a bare number where a word belongs', () => {
    expect(describeCredits(null)).toBe('Unlimited AI drafts');
    expect(describeCredits(-3)).toBe('No AI drafts remaining');
  });
});

describe('which mode the draft room is in', () => {
  const base = { creditsRemaining: 3, aiConfigured: true };

  it('says STANDARD for Basic, and offers nothing to switch on', () => {
    const mode = resolveDraftMode({ ...base, plan: 'basic', aiEnabledForDraft: false });
    expect(mode.kind).toBe('standard');
    expect(mode.label).toBe('Standard draft');
    expect(mode.detail).toBe('Juancho + First Seed');
    expect(mode.aiActive).toBe(false);
    expect(mode.canEnableAi).toBe(false);
  });

  it('a Basic account can never reach AI mode, whatever the flag says', () => {
    // Defence in depth: even if a client set the flag, the mode is not AI.
    const mode = resolveDraftMode({ ...base, plan: 'basic', aiEnabledForDraft: true });
    expect(mode.aiActive).toBe(false);
    expect(mode.kind).toBe('standard');
  });

  it('starts Pro in standard mode, with the offer visible', () => {
    const mode = resolveDraftMode({ ...base, plan: 'pro', aiEnabledForDraft: false });
    expect(mode.kind).toBe('pro_standard');
    expect(mode.label).toBe('Pro · Standard mode');
    expect(mode.detail).toBe('AI Strategist available');
    expect(mode.credits).toBe('3 AI drafts remaining');
    expect(mode.aiActive).toBe(false);
    expect(mode.canEnableAi).toBe(true);
  });

  it('switches Pro to AI mode only when the drafter asked', () => {
    const mode = resolveDraftMode({ ...base, plan: 'pro', aiEnabledForDraft: true });
    expect(mode.kind).toBe('ai');
    expect(mode.label).toBe('AI draft');
    expect(mode.detail).toBe('Claude Strategist active');
    expect(mode.credits).toBe('3 AI drafts remaining after this draft');
    expect(mode.aiActive).toBe(true);
  });

  it('does not offer AI to a Pro account with nothing left', () => {
    const mode = resolveDraftMode({
      plan: 'pro',
      aiEnabledForDraft: false,
      creditsRemaining: 0,
      aiConfigured: true,
    });
    expect(mode.canEnableAi).toBe(false);
    expect(mode.detail).toBe('No AI drafts left');
  });

  it('does not offer AI when the deployment has it switched off', () => {
    const mode = resolveDraftMode({ ...base, plan: 'pro', aiEnabledForDraft: false, aiConfigured: false });
    expect(mode.canEnableAi).toBe(false);
    expect(mode.aiActive).toBe(false);
  });

  it('marks admin as admin, and never shows it a credit count', () => {
    const mode = resolveDraftMode({
      plan: 'admin',
      aiEnabledForDraft: false,
      creditsRemaining: null,
      aiConfigured: true,
    });
    expect(mode.kind).toBe('ai_admin');
    expect(mode.label).toBe('AI draft · Admin');
    expect(mode.aiActive).toBe(true);
    expect(mode.credits).toBeNull();
  });

  it('drops admin to standard when the deployment has no strategist', () => {
    const mode = resolveDraftMode({
      plan: 'admin',
      aiEnabledForDraft: true,
      creditsRemaining: null,
      aiConfigured: false,
    });
    expect(mode.aiActive).toBe(false);
  });
});

describe('the badge on a phone', () => {
  /*
   * Mobile QA found the full labels pushing "YOUR PICK / ROUND 5/15" out of the
   * top bar - the mode indicator crowding out whose pick it is. The short form
   * has to stay short AND still answer the only question the badge is for.
   */
  const modes = [
    resolveDraftMode({ plan: 'basic', aiEnabledForDraft: false, creditsRemaining: 0, aiConfigured: true }),
    resolveDraftMode({ plan: 'pro', aiEnabledForDraft: false, creditsRemaining: 3, aiConfigured: true }),
    resolveDraftMode({ plan: 'pro', aiEnabledForDraft: true, creditsRemaining: 2, aiConfigured: true }),
    resolveDraftMode({ plan: 'admin', aiEnabledForDraft: true, creditsRemaining: null, aiConfigured: true }),
  ];

  it('fits: no short label is longer than the full one', () => {
    for (const mode of modes) {
      expect(mode.shortLabel.length, mode.kind).toBeLessThanOrEqual(mode.label.length);
      expect(mode.shortLabel.length, mode.kind).toBeLessThanOrEqual(12);
    }
  });

  it('still answers "am I getting AI right now?" on its own', () => {
    for (const mode of modes) {
      const saysAi = /ai/i.test(mode.shortLabel);
      expect(saysAi, `${mode.kind}: "${mode.shortLabel}"`).toBe(mode.aiActive);
    }
  });
});

describe('the question asked before a credit is spent', () => {
  it('says what a credit buys, so "a draft" is not left to interpretation', () => {
    const prompt = creditPrompt(3);
    expect(prompt.question).toBe('Use an AI Draft credit for this draft?');
    expect(prompt.remaining).toBe('3 AI drafts remaining');
    expect(prompt.explanation).toContain('entire draft');
    expect(prompt.explanation).toContain('Reopening');
    // Declining is a first-class answer, not a dismissal.
    expect(prompt.decline).toBe('Use Standard Mode');
    expect(prompt.confirm).toBe('Use AI Strategist');
  });
});

describe('what the recommendation card says it is', () => {
  const states: RecommendationCardState[] = [
    'engine',
    'engine_ai_running',
    'ai_confirmed',
    'ai_override',
    'engine_ai_unavailable',
    'unavailable',
  ];

  it('never says "engine" to a customer', () => {
    for (const state of states) {
      expect(cardBanner(state).label.toLowerCase(), state).not.toContain('engine');
    }
  });

  it('distinguishes agreement from disagreement WITHOUT relying on colour', () => {
    /*
     * The accessibility requirement, as an assertion. Somebody who cannot see
     * the difference between the two tones must still be able to read which
     * happened - so the mark and the words both have to differ.
     */
    const confirmed = cardBanner('ai_confirmed');
    const override = cardBanner('ai_override');
    expect(confirmed.mark).toBe('✓');
    expect(override.mark).toBe('↗');
    expect(confirmed.label).not.toBe(override.label);
    expect(confirmed.detail).not.toBe(override.detail);
  });

  it('keeps Juancho visible while the strategist thinks', () => {
    const running = cardBanner('engine_ai_running');
    expect(running.busy).toBe(true);
    expect(running.detail).toContain('stands');
  });

  it('leads with Juancho before any AI has spoken', () => {
    expect(cardBanner('engine').label).toBe('Juancho pick');
    expect(cardBanner('engine').detail).toContain('First Seed');
  });
});

describe('the offer lookup', () => {
  it('always returns something, and never the wrong one', () => {
    expect(offerFor('basic').id).toBe('basic');
    expect(offerFor('pro').id).toBe('pro');
  });
});
