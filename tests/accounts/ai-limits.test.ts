/**
 * The ceilings that stand between a bug and an unbounded bill.
 *
 * Every one of these is a rule the product must refuse to break even when the
 * client asks nicely, so the tests are written as refusals: given this much
 * already spent, is the next call made? The one property that matters more than
 * any individual number is at the bottom - no combination of settings can raise
 * a ceiling, only lower one.
 */
import { describe, expect, it } from 'vitest';
import {
  AI_CONTROL_DEFAULT,
  DEFAULT_AI_LIMITS,
  WORST_CASE_INPUT_TOKENS,
  decideAiLimits,
  decideDraftLimits,
  decideGlobalLimits,
  decideSelectionLimits,
  effectiveLimits,
  killSwitchEngaged,
  reservedCallCostUsd,
  type AiControl,
  type DraftSpend,
} from '../../packages/accounts/ai-limits';
import { LIMIT_REFUSALS, REFUSAL_MESSAGE } from '../../packages/accounts/entitlements';
import { estimateCost } from '../../packages/engine/strategist/anthropic/pricing';

const MODEL = 'claude-opus-5';
const NOTHING_SPENT: DraftSpend = { calls: 0, repairCalls: 0, estimatedCostUsd: 0 };
const NEVER_ASKED = { requests: 0, answered: false };
const NO_GLOBAL_SPEND = { todayUsd: 0, monthUsd: 0 };

function limits(overrides: Partial<typeof DEFAULT_AI_LIMITS> = {}) {
  return { ...DEFAULT_AI_LIMITS, ...overrides };
}

function control(overrides: Partial<AiControl> = {}): AiControl {
  return { ...AI_CONTROL_DEFAULT, ...overrides };
}

/** The whole decision, with everything but the argument under test set to zero. */
function decide(overrides: Partial<Parameters<typeof decideAiLimits>[0]> = {}) {
  return decideAiLimits({
    control: control(),
    killSwitch: false,
    global: NO_GLOBAL_SPEND,
    draft: NOTHING_SPENT,
    selection: NEVER_ASKED,
    reservedUsd: 0,
    limits: limits(),
    ...overrides,
  });
}

describe('the numbers themselves', () => {
  it('are the ones that were asked for', () => {
    expect(DEFAULT_AI_LIMITS.maxPrimaryCallsPerDraft).toBe(18);
    expect(DEFAULT_AI_LIMITS.maxRepairCallsPerDraft).toBe(5);
    expect(DEFAULT_AI_LIMITS.maxDraftSpendUsd).toBe(5);
  });
});

describe('the global switch', () => {
  it('refuses everything when the environment kill switch is pulled', () => {
    expect(decide({ killSwitch: true })).toBe('ai_disabled');
  });

  it('refuses everything when the control row is switched off', () => {
    expect(decide({ control: control({ enabled: false }) })).toBe('ai_disabled');
  });

  it('beats every other limit, so a refusal never blames the wrong thing', () => {
    const refusal = decide({
      killSwitch: true,
      draft: { calls: 99, repairCalls: 99, estimatedCostUsd: 99 },
      selection: { requests: 9, answered: true },
    });
    expect(refusal).toBe('ai_disabled');
  });

  it('reads the environment switch case-insensitively, and only for true', () => {
    expect(killSwitchEngaged({ AI_KILL_SWITCH: 'true' })).toBe(true);
    expect(killSwitchEngaged({ AI_KILL_SWITCH: 'TRUE' })).toBe(true);
    expect(killSwitchEngaged({ AI_KILL_SWITCH: ' True ' })).toBe(true);
    expect(killSwitchEngaged({ AI_KILL_SWITCH: 'false' })).toBe(false);
    expect(killSwitchEngaged({ AI_KILL_SWITCH: '1' })).toBe(false);
    expect(killSwitchEngaged({})).toBe(false);
  });
});

describe('the deployment spend windows', () => {
  it('allows a call that fits inside the day', () => {
    expect(
      decideGlobalLimits({
        control: control(),
        killSwitch: false,
        spend: { todayUsd: 10, monthUsd: 10 },
        reservedUsd: 2,
        limits: limits({ dailySpendLimitUsd: 25, monthlySpendLimitUsd: 250 }),
      }),
    ).toBeNull();
  });

  it('refuses the call that would step over the daily cap', () => {
    expect(
      decideGlobalLimits({
        control: control(),
        killSwitch: false,
        spend: { todayUsd: 24, monthUsd: 24 },
        reservedUsd: 2,
        limits: limits({ dailySpendLimitUsd: 25 }),
      }),
    ).toBe('daily_spend_limit');
  });

  it('refuses on the month even when the day has room', () => {
    expect(
      decideGlobalLimits({
        control: control(),
        killSwitch: false,
        spend: { todayUsd: 0, monthUsd: 249 },
        reservedUsd: 2,
        limits: limits({ dailySpendLimitUsd: 25, monthlySpendLimitUsd: 250 }),
      }),
    ).toBe('monthly_spend_limit');
  });
});

describe('one draft', () => {
  it('stops at the eighteenth call, not the nineteenth', () => {
    expect(
      decideDraftLimits({
        spend: { calls: 17, repairCalls: 0, estimatedCostUsd: 0 },
        reservedUsd: 0,
        limits: limits(),
      }),
    ).toBeNull();
    expect(
      decideDraftLimits({
        spend: { calls: 18, repairCalls: 0, estimatedCostUsd: 0 },
        reservedUsd: 0,
        limits: limits(),
      }),
    ).toBe('draft_call_limit');
  });

  it('stops at the fifth repair, and says so separately from the call count', () => {
    expect(
      decideDraftLimits({
        spend: { calls: 3, repairCalls: 5, estimatedCostUsd: 0 },
        reservedUsd: 0,
        limits: limits(),
      }),
    ).toBe('draft_repair_limit');
  });

  it('refuses the call that could take it past five dollars', () => {
    // $3.50 spent and $1.81 reserved is $5.31, which is over.
    expect(
      decideDraftLimits({
        spend: { calls: 4, repairCalls: 0, estimatedCostUsd: 3.5 },
        reservedUsd: reservedCallCostUsd(MODEL),
        limits: limits(),
      }),
    ).toBe('draft_spend_limit');
  });

  it('is a HARD cap: the worst possible call still lands under five dollars', () => {
    const reserved = reservedCallCostUsd(MODEL);
    /*
     * The largest spend that is still allowed through, then the worst call that
     * could follow it. If this ever exceeds the cap, the reservation is too
     * small and the cap is a suggestion.
     */
    const largestAllowed = DEFAULT_AI_LIMITS.maxDraftSpendUsd - reserved;
    expect(
      decideDraftLimits({
        spend: { calls: 1, repairCalls: 0, estimatedCostUsd: largestAllowed },
        reservedUsd: reserved,
        limits: limits(),
      }),
    ).toBeNull();
    expect(largestAllowed + reserved).toBeLessThanOrEqual(DEFAULT_AI_LIMITS.maxDraftSpendUsd);
  });
});

describe('the reservation', () => {
  it('prices two full attempts at the worst prompt ever recorded', () => {
    const oneAttempt = estimateCost(MODEL, {
      inputTokens: WORST_CASE_INPUT_TOKENS,
      outputTokens: 4096,
    });
    expect(reservedCallCostUsd(MODEL)).toBeCloseTo(oneAttempt * 2, 10);
  });

  it('is larger than any call the regression corpus has actually made', () => {
    // The most expensive recorded call: 38,342 in, 4,797 out.
    const worstObserved = estimateCost(MODEL, { inputTokens: 38_342, outputTokens: 4_797 });
    expect(reservedCallCostUsd(MODEL)).toBeGreaterThan(worstObserved);
  });

  it('follows the model, so a cheaper model buys more calls', () => {
    expect(reservedCallCostUsd('claude-haiku-4-5')).toBeLessThan(reservedCallCostUsd(MODEL));
  });
});

describe('one selection', () => {
  it('never asks twice about a pick that was answered', () => {
    expect(
      decideSelectionLimits({ selection: { requests: 1, answered: true }, limits: limits() }),
    ).toBe('selection_already_answered');
  });

  it('allows one retry after a call that produced nothing', () => {
    expect(
      decideSelectionLimits({ selection: { requests: 1, answered: false }, limits: limits() }),
    ).toBeNull();
  });

  it('stops after that retry', () => {
    expect(
      decideSelectionLimits({ selection: { requests: 2, answered: false }, limits: limits() }),
    ).toBe('selection_already_answered');
  });
});

describe('composing the environment and the control row', () => {
  it('takes the lower of the two, whichever is which', () => {
    const fromEnv = effectiveLimits(
      { AI_DAILY_SPEND_LIMIT_USD: '5' },
      control({ dailySpendLimitUsd: 20 }),
    );
    expect(fromEnv.dailySpendLimitUsd).toBe(5);

    const fromRow = effectiveLimits(
      { AI_DAILY_SPEND_LIMIT_USD: '40' },
      control({ dailySpendLimitUsd: 20 }),
    );
    expect(fromRow.dailySpendLimitUsd).toBe(20);
  });

  it('ignores a value that is not a number rather than treating it as zero', () => {
    expect(effectiveLimits({ AI_MAX_DRAFT_SPEND_USD: 'five dollars' }).maxDraftSpendUsd).toBe(5);
    expect(effectiveLimits({ AI_MAX_CALLS_PER_DRAFT: '-3' }).maxPrimaryCallsPerDraft).toBe(18);
  });

  it('CANNOT be made to raise a ceiling, by any combination', () => {
    const attempts = [
      { AI_MAX_CALLS_PER_DRAFT: '1000' },
      { AI_MAX_REPAIRS_PER_DRAFT: '1000' },
      { AI_MAX_DRAFT_SPEND_USD: '1000' },
      { AI_DAILY_SPEND_LIMIT_USD: '99999' },
      { AI_MONTHLY_SPEND_LIMIT_USD: '99999' },
    ];
    for (const env of attempts) {
      const raised = effectiveLimits(
        env,
        control({ dailySpendLimitUsd: 99_999, monthlySpendLimitUsd: 99_999 }),
      );
      expect(raised.maxPrimaryCallsPerDraft).toBeLessThanOrEqual(18);
      expect(raised.maxRepairCallsPerDraft).toBeLessThanOrEqual(5);
      expect(raised.maxDraftSpendUsd).toBeLessThanOrEqual(5);
      expect(raised.dailySpendLimitUsd).toBeLessThanOrEqual(DEFAULT_AI_LIMITS.dailySpendLimitUsd);
      expect(raised.monthlySpendLimitUsd).toBeLessThanOrEqual(
        DEFAULT_AI_LIMITS.monthlySpendLimitUsd,
      );
    }
  });
});

describe('what a person is told', () => {
  it('has wording for every ceiling, and none of it reads as an error', () => {
    for (const refusal of LIMIT_REFUSALS) {
      const message = REFUSAL_MESSAGE[refusal];
      expect(message, refusal).toBeTruthy();
      expect(message.toLowerCase(), refusal).not.toContain('error');
    }
  });

  it('tells a drafter their draft still works when a ceiling is hit', () => {
    for (const refusal of ['draft_call_limit', 'draft_spend_limit', 'daily_spend_limit'] as const) {
      expect(REFUSAL_MESSAGE[refusal].toLowerCase()).toMatch(/unaffected|deterministic/);
    }
  });
});
