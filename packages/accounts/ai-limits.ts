/**
 * The hard ceilings on AI spending, decided without a database in sight.
 *
 * `entitlements.ts` answers "is this person allowed to use the strategist at
 * all". This answers the question that comes after it: given that they are,
 * has this draft, this selection, or this whole deployment already had enough?
 * The two are separate because they fail for different reasons and a person can
 * do something about only one of them - a plan is theirs to change, and a draft
 * that has spent five dollars is not.
 *
 * Every rule here is a pure function over plain numbers, for the same reason
 * the entitlement rules are: the limits that stand between a bug and an
 * unbounded bill should be exhaustively testable without Postgres, a network,
 * or a key.
 *
 * THE CONTRACT WHEN A LIMIT IS HIT. Nothing here throws and nothing here is an
 * error. A refusal means the deterministic engine carries the draft exactly as
 * it always does and Anthropic is never contacted. That is the whole point: a
 * cap that degraded the product would be a cap nobody dared set low enough.
 *
 * NOTHING HERE READS ANYTHING THE BROWSER SENT. The counts come from our own
 * `ai_usage` rows and the limits from our own configuration.
 */
import { estimateCost } from '../engine/strategist/anthropic/pricing';
import type { AiRefusal } from './entitlements';

/* ------------------------------------------------------------- the numbers */

export interface AiLimits {
  /** Calls to Anthropic allowed in one draft, repairs excluded. */
  maxPrimaryCallsPerDraft: number;
  /**
   * Second attempts allowed in one draft.
   *
   * A repair happens when a reply fails the response contract and is asked
   * again with the problems named. It is a real, billable call, and a model
   * having a bad afternoon is exactly the failure mode that turns a normal
   * draft into an expensive one - so they are counted and capped separately
   * rather than hidden inside the primary count.
   */
  maxRepairCallsPerDraft: number;
  /** Estimated dollars one draft may spend, across every call it makes. */
  maxDraftSpendUsd: number;
  /**
   * Requests allowed for one selection of ours.
   *
   * A selection that has already produced an answer is never asked again at
   * any count - `alreadyAnswered` below refuses that outright, and this only
   * bounds retries after a call that produced nothing. Two, because a single
   * dropped connection on the one pick a person cared about should not cost
   * them the feature, and three would start to look like a loop.
   */
  maxRequestsPerSelection: number;
  /** Estimated dollars the whole deployment may spend in a UTC day. */
  dailySpendLimitUsd: number;
  /** Estimated dollars the whole deployment may spend in a UTC month. */
  monthlySpendLimitUsd: number;
  /**
   * How long a request may hold its slot before another may take it.
   *
   * The concurrency guarantees are held by a lease row, and a process that
   * dies mid-call must not lock a user out of their own draft forever. A call
   * takes seventeen to twenty seconds including a repair, so two minutes is
   * far beyond a slow one and far below anything a person would sit through.
   */
  leaseSeconds: number;
}

export const DEFAULT_AI_LIMITS: AiLimits = {
  maxPrimaryCallsPerDraft: 18,
  maxRepairCallsPerDraft: 5,
  maxDraftSpendUsd: 5,
  maxRequestsPerSelection: 2,
  dailySpendLimitUsd: 25,
  monthlySpendLimitUsd: 250,
  leaseSeconds: 120,
};

/**
 * The largest input a strategist call has ever been sent, rounded up.
 *
 * Measured over the sixty recorded calls in the regression corpus, whose input
 * sizes run from 7,872 to 38,342 tokens. It is used to reserve worst-case cost
 * against a cap, so it is deliberately the maximum rather than a percentile: a
 * cap that a single unusually large call can step over is not a hard cap.
 */
export const WORST_CASE_INPUT_TOKENS = 40_000;

/**
 * What one more call could cost, at worst, before it is made.
 *
 * A spend cap has to be enforced BEFORE the money is spent, and the price of a
 * call is only known after it returns. So the check reserves the worst case:
 * the largest prompt ever recorded and a full output budget, twice, because a
 * call is allowed one repair. On the production model that is about $1.81
 * against a $5 draft cap, which means the cap is genuinely never exceeded
 * rather than usually not exceeded.
 *
 * Cache reads and writes are ignored on purpose. A cache read is a tenth of the
 * base rate and a write is a quarter more; pricing the reservation as if every
 * token were fresh input is the conservative direction, and the conservative
 * direction is the only correct one for a reservation.
 */
export function reservedCallCostUsd(
  model: string,
  { maxOutputTokens = 4096, maxAttempts = 2 } = {},
): number {
  const perAttempt = estimateCost(model, {
    inputTokens: WORST_CASE_INPUT_TOKENS,
    outputTokens: maxOutputTokens,
  });
  return perAttempt * maxAttempts;
}

/* --------------------------------------------------------- the global switch */

/**
 * Whether AI is switched on for the whole deployment, and how much it may spend.
 *
 * Two sources, and they compose rather than override. The environment is the
 * deploy-time position and the database row is the live one, so an operator can
 * stop all spending in one statement without a restart, and a deploy can stop
 * it without needing the database to be reachable.
 *
 * Off wins, and the lower number wins. There is no combination of settings in
 * which adding a second limit makes the deployment spend more.
 */
export interface AiControl {
  enabled: boolean;
  disabledReason: string | null;
  dailySpendLimitUsd: number | null;
  monthlySpendLimitUsd: number | null;
}

export const AI_CONTROL_DEFAULT: AiControl = {
  enabled: true,
  disabledReason: null,
  dailySpendLimitUsd: null,
  monthlySpendLimitUsd: null,
};

export type Environment = Record<string, string | undefined>;

function positiveNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw.trim());
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** The kill switch that does not need the database to work. */
export function killSwitchEngaged(env: Environment = process.env): boolean {
  return env.AI_KILL_SWITCH?.trim().toLowerCase() === 'true';
}

/**
 * The limits actually in force.
 *
 * Environment first, database second, and the smaller of the two wherever both
 * have an opinion. An unparseable or negative value is ignored rather than
 * treated as zero: a typo in a spend limit should not silently disable the
 * product, and it should certainly not silently raise the ceiling.
 */
export function effectiveLimits(
  env: Environment = process.env,
  control: AiControl = AI_CONTROL_DEFAULT,
  base: AiLimits = DEFAULT_AI_LIMITS,
): AiLimits {
  const lower = (a: number, ...others: (number | null)[]): number =>
    others.reduce<number>((least, value) => (value === null ? least : Math.min(least, value)), a);

  return {
    ...base,
    maxPrimaryCallsPerDraft: lower(
      base.maxPrimaryCallsPerDraft,
      positiveNumber(env.AI_MAX_CALLS_PER_DRAFT),
    ),
    maxRepairCallsPerDraft: lower(
      base.maxRepairCallsPerDraft,
      positiveNumber(env.AI_MAX_REPAIRS_PER_DRAFT),
    ),
    maxDraftSpendUsd: lower(base.maxDraftSpendUsd, positiveNumber(env.AI_MAX_DRAFT_SPEND_USD)),
    dailySpendLimitUsd: lower(
      base.dailySpendLimitUsd,
      positiveNumber(env.AI_DAILY_SPEND_LIMIT_USD),
      control.dailySpendLimitUsd,
    ),
    monthlySpendLimitUsd: lower(
      base.monthlySpendLimitUsd,
      positiveNumber(env.AI_MONTHLY_SPEND_LIMIT_USD),
      control.monthlySpendLimitUsd,
    ),
  };
}

/* ------------------------------------------------------------- the decisions */

/** What a draft has already spent, read from `ai_usage`. */
export interface DraftSpend {
  /** Primary calls. One row per call, so this is a row count. */
  calls: number;
  repairCalls: number;
  estimatedCostUsd: number;
}

/** What the deployment has spent, in the two windows that are capped. */
export interface GlobalSpend {
  todayUsd: number;
  monthUsd: number;
}

/** What this selection of ours has already been asked. */
export interface SelectionSpend {
  requests: number;
  /** True once a call for this selection came back with a response. */
  answered: boolean;
}

/**
 * Is the whole deployment allowed to spend right now?
 *
 * Checked before anything about the user, because a kill switch that only
 * applied to some plans would not be a kill switch. The spend windows reserve
 * the same worst case a draft does, so a global cap cannot be stepped over by
 * one large call either.
 */
export function decideGlobalLimits({
  control,
  killSwitch,
  spend,
  reservedUsd,
  limits,
}: {
  control: AiControl;
  killSwitch: boolean;
  spend: GlobalSpend;
  reservedUsd: number;
  limits: AiLimits;
}): AiRefusal | null {
  if (killSwitch || !control.enabled) return 'ai_disabled';
  if (spend.todayUsd + reservedUsd > limits.dailySpendLimitUsd) return 'daily_spend_limit';
  if (spend.monthUsd + reservedUsd > limits.monthlySpendLimitUsd) return 'monthly_spend_limit';
  return null;
}

/**
 * Has this draft had enough?
 *
 * Order is by how surprising the answer would be. Running out of calls is the
 * ordinary end of a long draft; running out of repairs means the model is
 * misbehaving; hitting the spend cap means something is wrong with our
 * assumptions about what a call costs, and it is the one an operator most needs
 * to see named rather than folded into the others.
 */
export function decideDraftLimits({
  spend,
  reservedUsd,
  limits,
}: {
  spend: DraftSpend;
  reservedUsd: number;
  limits: AiLimits;
}): AiRefusal | null {
  if (spend.calls >= limits.maxPrimaryCallsPerDraft) return 'draft_call_limit';
  if (spend.repairCalls >= limits.maxRepairCallsPerDraft) return 'draft_repair_limit';
  if (spend.estimatedCostUsd + reservedUsd > limits.maxDraftSpendUsd) return 'draft_spend_limit';
  return null;
}

/**
 * Have we already bought an answer for this pick?
 *
 * The dedupe key is the selection - our overall pick number - and deliberately
 * NOT the board fingerprint. During our own turn the board can still change,
 * and keying on the fingerprint would treat a correction as a new question and
 * pay for it again. It is the same pick either way, and one pick buys one
 * answer.
 *
 * A caller that lies about its pick number defeats this and nothing else: the
 * per-draft call, repair and spend caps are counted from our own rows and do
 * not consult the client at all.
 */
export function decideSelectionLimits({
  selection,
  limits,
}: {
  selection: SelectionSpend;
  limits: AiLimits;
}): AiRefusal | null {
  if (selection.answered) return 'selection_already_answered';
  if (selection.requests >= limits.maxRequestsPerSelection) {
    return 'selection_already_answered';
  }
  return null;
}

/**
 * Everything the caps have to say, in the order they are checked.
 *
 * A single entry point so the route cannot accidentally check two of the three
 * and ship. Concurrency is not decided here: one active request per user and
 * one per draft are held by a uniquely-indexed lease row, because a check
 * followed by an insert is not mutual exclusion.
 */
export function decideAiLimits({
  control,
  killSwitch,
  global,
  draft,
  selection,
  reservedUsd,
  limits,
}: {
  control: AiControl;
  killSwitch: boolean;
  global: GlobalSpend;
  draft: DraftSpend;
  selection: SelectionSpend;
  reservedUsd: number;
  limits: AiLimits;
}): AiRefusal | null {
  return (
    decideGlobalLimits({ control, killSwitch, spend: global, reservedUsd, limits }) ??
    decideDraftLimits({ spend: draft, reservedUsd, limits }) ??
    decideSelectionLimits({ selection, limits })
  );
}
