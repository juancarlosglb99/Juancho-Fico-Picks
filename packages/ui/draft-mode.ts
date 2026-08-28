/**
 * Which product the person in the draft room is actually using.
 *
 * The complaint this exists to answer: sitting in the draft room, you could not
 * tell whether you were getting the deterministic engine or the paid strategist.
 * For a free feature that is untidy. For a paid one it is the difference between
 * a customer who feels the upgrade and one who quietly wonders what they bought.
 *
 * Two rules shape everything here.
 *
 * COLOUR IS NEVER THE SIGNAL. Every state carries words, and the two that are
 * easiest to confuse - AI agreed, AI disagreed - carry a distinct mark as well.
 * A person who cannot separate green from amber must still be able to read what
 * happened.
 *
 * NO IMPLEMENTATION LANGUAGE. No model ids, no token counts, no provider names,
 * no "API". A customer bought a draft strategist; what it is built from is our
 * problem. `Claude` appears because it is the strategist's name to the customer,
 * the way a car has an engine name - never `claude-opus-5`.
 */
import type { Plan } from '../accounts/entitlements';
import { describeCredits } from './plans';
import type { RecommendationCardState } from './recommendation';

/* --------------------------------------------- the persistent mode indicator */

export type DraftModeKind =
  /** Basic. The deterministic product, and complete on its own terms. */
  | 'standard'
  /** Pro, with the strategist switched off for this draft. */
  | 'pro_standard'
  /** Pro, with the strategist running on this draft. */
  | 'ai'
  /** Admin, which always has the strategist and never pays for it. */
  | 'ai_admin';

export interface DraftMode {
  kind: DraftModeKind;
  /** The badge. Short, and never the only thing said. */
  label: string;
  /** What that means, in the customer's words. */
  detail: string;
  /** A third line when there is something true to put there. */
  credits: string | null;
  /** True when the strategist is actually going to be asked. */
  aiActive: boolean;
  /** True when the person could turn AI on for this draft and has not. */
  canEnableAi: boolean;
}

/**
 * What the draft room says it is.
 *
 * `aiEnabledForDraft` is the user's explicit choice for THIS draft, not a
 * property of their plan: a Pro drafter running a casual mock should not spend
 * a credit, so Pro defaults to standard mode until they say otherwise.
 */
export function resolveDraftMode({
  plan,
  aiEnabledForDraft,
  creditsRemaining,
  aiConfigured,
}: {
  plan: Plan;
  aiEnabledForDraft: boolean;
  /** Null means unmetered. */
  creditsRemaining: number | null;
  /** False when the deployment has no strategist, or it is switched off. */
  aiConfigured: boolean;
}): DraftMode {
  if (plan === 'admin') {
    if (!aiConfigured) {
      return {
        kind: 'standard',
        label: 'Standard draft',
        detail: 'Juancho + First Seed',
        credits: 'AI Strategist unavailable right now',
        aiActive: false,
        canEnableAi: false,
      };
    }
    return {
      kind: 'ai_admin',
      label: 'AI draft · Admin',
      detail: 'Claude Strategist active',
      credits: null,
      aiActive: true,
      canEnableAi: false,
    };
  }

  if (plan !== 'pro') {
    return {
      kind: 'standard',
      label: 'Standard draft',
      detail: 'Juancho + First Seed',
      credits: null,
      aiActive: false,
      canEnableAi: false,
    };
  }

  // Pro from here down.
  const remaining = creditsRemaining ?? 0;

  if (aiEnabledForDraft && aiConfigured) {
    return {
      kind: 'ai',
      label: 'AI draft',
      detail: 'Claude Strategist active',
      /*
       * The balance the server reports is already net of this draft's credit -
       * it is spent when AI is switched on, not when the draft ends - so this
       * is genuinely what is left afterwards rather than a prediction.
       */
      credits: `${remaining} AI draft${remaining === 1 ? '' : 's'} remaining after this draft`,
      aiActive: true,
      canEnableAi: false,
    };
  }

  const outOfCredits = creditsRemaining !== null && remaining <= 0;
  return {
    kind: 'pro_standard',
    label: 'Pro · Standard mode',
    detail: !aiConfigured
      ? 'AI Strategist unavailable right now'
      : outOfCredits
        ? 'No AI drafts left'
        : 'AI Strategist available',
    credits: describeCredits(creditsRemaining),
    aiActive: false,
    canEnableAi: aiConfigured && !outOfCredits,
  };
}

/* ------------------------------------------------ the AI opt-in, before cost */

export interface CreditPrompt {
  question: string;
  remaining: string;
  /** What one credit actually buys, because "a draft" is worth spelling out. */
  explanation: string;
  confirm: string;
  decline: string;
}

/**
 * The question asked before a credit is ever spent.
 *
 * Opening a draft, browsing one, or starting a mock must not cost anything. A
 * credit buys a DRAFT with the strategist switched on, and this is where a
 * person says yes to that - once, per draft.
 */
export function creditPrompt(creditsRemaining: number | null): CreditPrompt {
  return {
    question: 'Use an AI Draft credit for this draft?',
    remaining: describeCredits(creditsRemaining),
    explanation:
      'One credit covers this entire draft - every pick, for as long as it runs. Reopening it later costs nothing more.',
    confirm: 'Use AI Strategist',
    decline: 'Use Standard Mode',
  };
}

/* ------------------------------------------- what the recommendation card says */

export interface CardBanner {
  /** The heading above the recommendation. */
  label: string;
  /** The line under it. Null where the plain verdict says it better. */
  detail: string | null;
  /**
   * A mark that is not a colour.
   *
   * Only on the two states a person must be able to tell apart at a glance,
   * and readable by somebody who cannot see the difference between the tones
   * they are drawn in.
   */
  mark: '✓' | '↗' | null;
  /** True while a request is in flight, for a spinner or a pulse. */
  busy: boolean;
}

export function cardBanner(state: RecommendationCardState): CardBanner {
  switch (state) {
    case 'engine':
      return {
        label: 'Juancho pick',
        detail: 'Based on First Seed + live draft simulation',
        mark: null,
        busy: false,
      };
    case 'engine_ai_running':
      return {
        label: 'AI Strategist analysing…',
        // The Juancho pick stays on screen underneath. Saying so stops the
        // banner reading as "wait for the real answer".
        detail: 'Juancho’s pick stands until it finishes',
        mark: null,
        busy: true,
      };
    case 'ai_confirmed':
      return {
        label: 'AI confirmed',
        detail: 'Claude independently agrees with Juancho',
        mark: '✓',
        busy: false,
      };
    case 'ai_override':
      return {
        label: 'AI override',
        detail: 'Claude recommends a different player after deeper analysis',
        mark: '↗',
        busy: false,
      };
    case 'engine_ai_unavailable':
      return {
        label: 'Juancho pick',
        detail: 'The AI Strategist did not weigh in on this pick',
        mark: null,
        busy: false,
      };
    case 'unavailable':
      return { label: 'No recommendation yet', detail: null, mark: null, busy: false };
  }
}
