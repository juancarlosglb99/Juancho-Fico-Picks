/**
 * The strategist during a live draft.
 *
 * The constraint that shapes everything here: a recommendation must be on
 * screen in well under a second, and a strategist call takes twenty. So the
 * deterministic engine renders immediately and the strategist never sits in
 * that path - it runs alongside, and upgrades the answer if and when it
 * arrives. Every failure mode ends with the deterministic pick still showing,
 * because a draft clock does not wait for an outage.
 *
 * Staleness is the subtle danger. A reply about pick 47 can arrive after the
 * room has reached 49, and applied silently it looks exactly like fresh advice
 * while describing players who are already gone. Every result is checked
 * against the board it was asked about, and anything else is discarded whole.
 *
 * Framework-free on purpose: the React hook is a thin subscription over this,
 * and every behaviour below is tested with a fake transport rather than a
 * browser.
 */
import type { StrategistResponse } from './anthropic/schema';
import { estimateCost } from './anthropic/pricing';
import { resolveStrategistDecision, type StrategistDecision } from './audit';
import type { GuardrailViolationCode } from './guardrails';
import type { ResponseValidationProblem } from './audit';
import { buildStrategistPromptContext, type StrategistPromptContext } from './prompt-context';
import { stalenessOf } from './state-version';
import type { DraftBrief, DraftStateVersion, StrategistAdvice } from './types';

/* ------------------------------------------------------------- the transport */

/** What the server route hands back. Deliberately not advice yet. */
export interface StrategistTransportResult {
  response: StrategistResponse | null;
  problems: ResponseValidationProblem[];
  /** Which board this was asked about, echoed so a reply cannot be mismatched. */
  state: DraftStateVersion;
  model: string;
  usage: {
    inputTokens: number;
    cacheWriteTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
  } | null;
  attempts: number;
  latencyMs: number;
  error: string | null;

  /* --- present once accounts exist; absent when they are switched off --- */

  /**
   * The draft's running total, from the server's database.
   *
   * When this is present it is the AUTHORITY and the local ledger mirrors it,
   * which is the whole reconciliation: one formula (`estimateCost`, used on
   * both sides) and one record (the `ai_usage` table). Accumulating locally as
   * well would produce a second set of books that drifts the first time a
   * request is retried or a tab is reopened.
   */
  accountUsage?: {
    calls: number;
    repairCalls: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    estimatedCostUsd: number;
    failures: number;
  } | null;
  /** The plan the server applied. Never something the client asserted. */
  plan?: 'basic' | 'pro' | 'admin';
  creditsRemaining?: number | null;
  /** Why the server declined, when it did. */
  refusal?: string | null;
}

export interface StrategistTransport {
  advise(input: {
    context: StrategistPromptContext;
    boardPlayerIds: string[];
    state: DraftStateVersion;
    /** Session metadata. Nothing here can affect what the server authorises. */
    leagueId?: string | null;
    isMock?: boolean;
    signal?: AbortSignal;
  }): Promise<StrategistTransportResult>;
}

/* ---------------------------------------------------------------- accounting */

/**
 * What the strategist has cost, per draft.
 *
 * Built now because a per-user cap needs somewhere to read from, and retrofitting
 * accounting after the fact means guessing at history. No payments and no
 * enforcement here - only the numbers a cap would eventually consult.
 */
export interface UsageRecord {
  draftId: string;
  calls: number;
  /** Second attempts caused by a response that failed the contract. */
  repairCalls: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  failures: number;
}

export class UsageLedger {
  private readonly records = new Map<string, UsageRecord>();

  record(draftId: string, result: StrategistTransportResult): UsageRecord {
    /*
     * The server keeps the books when there are books to keep. Mirroring rather
     * than accumulating is what stops the screen and the database disagreeing
     * about what a draft has cost.
     */
    if (result.accountUsage) {
      const authoritative: UsageRecord = { draftId, ...result.accountUsage };
      this.records.set(draftId, authoritative);
      return authoritative;
    }

    const entry = this.records.get(draftId) ?? {
      draftId,
      calls: 0,
      repairCalls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      failures: 0,
    };
    entry.calls += 1;
    // Attempts beyond the first are repairs, and they are billed like any call.
    entry.repairCalls += Math.max(0, result.attempts - 1);
    if (result.usage) {
      entry.inputTokens += result.usage.inputTokens;
      entry.cacheReadTokens += result.usage.cacheReadTokens;
      entry.cacheWriteTokens += result.usage.cacheWriteTokens;
      entry.outputTokens += result.usage.outputTokens;
      entry.estimatedCostUsd =
        Math.round(
          (entry.estimatedCostUsd + estimateCost(result.model, result.usage)) * 10000,
        ) / 10000;
    }
    if (result.response === null) entry.failures += 1;
    this.records.set(draftId, entry);
    return entry;
  }

  get(draftId: string): UsageRecord | null {
    return this.records.get(draftId) ?? null;
  }

  all(): UsageRecord[] {
    return [...this.records.values()];
  }
}

/* -------------------------------------------------------------- call policy */

/**
 * When to spend a call.
 *
 * Not after every pick: a fifteen-round draft is a hundred and fifty
 * selections, and the strategist has nothing to say about most of them. It
 * starts thinking as our turn approaches and always answers fresh when we are
 * actually on the clock, which is the only moment the answer is acted on.
 */
export type CallCadence =
  /**
   * One call per turn of ours, made when we are actually on the clock.
   *
   * The safe default, and the reason is arithmetic rather than caution. A call
   * takes seventeen to twenty seconds; a pick lands every thirty or so. Asking
   * three picks early means the board very often moves before the answer
   * arrives, and a stale answer is discarded - so the money is spent and
   * nothing is shown. Waiting until the clock is ours means the board cannot
   * move underneath the request in the ordinary case.
   */
  | 'on_the_clock_only'
  /**
   * Begin as our turn approaches, so an answer is waiting when it arrives.
   *
   * Worth having once latency comes down or the answer can be revised in
   * place. Kept configurable rather than deleted.
   */
  | 'approaching_turn';

export interface StrategistCallPolicy {
  cadence: CallCadence;
  /** Only consulted under `approaching_turn`. */
  analyzeWithin: number;
  /**
   * Calls allowed for one selection of ours.
   *
   * Two, and the second is only ever reached when the first completed without
   * producing advice - an outage, or a response still malformed after its
   * repair. A call that produced advice, or that was abandoned because the
   * board moved, spends the selection: re-asking there would pay twice for one
   * pick, which is the failure this policy exists to prevent.
   */
  maxCallsPerSelection: number;
  /** Set false to stop calling entirely, for a cap or a kill switch. */
  enabled: boolean;
}

export const DEFAULT_CALL_POLICY: StrategistCallPolicy = {
  cadence: 'on_the_clock_only',
  analyzeWithin: 3,
  maxCallsPerSelection: 2,
  enabled: true,
};

/** The pre-turn policy, kept for when latency makes it worth the risk again. */
export const APPROACHING_TURN_POLICY: StrategistCallPolicy = {
  ...DEFAULT_CALL_POLICY,
  cadence: 'approaching_turn',
};

export function shouldRequest(
  brief: DraftBrief,
  policy: StrategistCallPolicy,
): boolean {
  if (!policy.enabled) return false;
  if (brief.draft.isOurSelection) return true;
  if (policy.cadence === 'on_the_clock_only') return false;
  const until = brief.draft.picksUntilOurNextSelection;
  return until !== null && until <= policy.analyzeWithin;
}

/**
 * Which selection of ours a board belongs to.
 *
 * The dedupe key, and deliberately NOT the board fingerprint. During our turn
 * the board can still change - a correction, a keeper resolving late - and
 * keying on the fingerprint would treat that as a new question and pay for it
 * again. It is the same pick either way, and we only buy one answer per pick.
 */
function selectionKey(brief: DraftBrief): string {
  return `${brief.state.draftId}#${brief.draft.currentOverallPick}`;
}

/** What has already been spent on one selection of ours. */
interface SelectionSpend {
  calls: number;
  /** True once a call returned advice, or was abandoned mid-flight. */
  settled: boolean;
}

/* ----------------------------------------------------------------- the state */

export type StrategistPhase =
  /** Not our concern yet - our turn is far off, or calling is disabled. */
  | 'idle'
  /** A request is in flight for the board currently on screen. */
  | 'analyzing'
  /** Advice arrived, passed the guardrails, and is being shown. */
  | 'ready'
  /** Something went wrong; the deterministic pick stands. */
  | 'fallback';

export interface LiveStrategistState {
  phase: StrategistPhase;
  /** The board this state describes. Never rendered against another. */
  fingerprint: string | null;
  decision: StrategistDecision | null;
  /**
   * What the DRAFTER is told. Always a curated sentence, never a raw fault.
   *
   * Production incident: a malformed model response put
   * "The strategist's response did not satisfy the contract.
   * recommendedPlayerId: Required field ..." on a customer's screen, because
   * this used to prefer the transport's own error string over the curated one.
   * The transport's string is written for us, not for them.
   */
  reason: string | null;
  /**
   * The exact fault, for diagnostics and the server log. NEVER rendered in the
   * normal draft UI.
   */
  technicalDetail: string | null;
  usage: UsageRecord | null;
  /**
   * What the server said about this caller's entitlement, when it said anything.
   *
   * Display only. Every decision it describes was already made server-side; a
   * client that rewrote this would change a label and nothing else.
   */
  entitlement: {
    plan: 'basic' | 'pro' | 'admin';
    creditsRemaining: number | null;
    refusal: string | null;
  } | null;
}

/**
 * Refusals that mean "stop asking for the rest of this draft".
 *
 * The server enforces every one of these on its own and will keep refusing, so
 * this changes nothing about what is authorised - it only stops a poll that
 * fires every few seconds from making a pointless round trip on every tick for
 * the next two hours.
 *
 * `request_in_flight` and `selection_already_answered` are deliberately NOT
 * here: both are about this moment or this pick, and the next pick is a fair
 * question again.
 */
const TERMINAL_REFUSALS: ReadonlySet<string> = new Set([
  'not_signed_in',
  'not_activated',
  'plan_does_not_include_ai',
  'entitlement_expired',
  'no_credits_remaining',
  'credits_expired',
  'strategist_not_configured',
  'ai_disabled',
  'draft_call_limit',
  'draft_repair_limit',
  'draft_spend_limit',
  'daily_spend_limit',
  'monthly_spend_limit',
]);

const IDLE: LiveStrategistState = {
  phase: 'idle',
  fingerprint: null,
  decision: null,
  reason: null,
  technicalDetail: null,
  usage: null,
  entitlement: null,
};

/**
 * Runs the strategist alongside a live draft.
 *
 * One request at a time. A new board aborts whatever was in flight, because a
 * reply about a board that has moved cannot be used and paying attention to it
 * only risks showing it.
 */
export class LiveStrategist {
  private state: LiveStrategistState = IDLE;
  private readonly listeners = new Set<(state: LiveStrategistState) => void>();
  private inFlight: AbortController | null = null;
  /** Which of OUR selections we have already paid for, and how it went. */
  private readonly spend = new Map<string, SelectionSpend>();
  /** The selection currently in flight, so a poll cannot start a second one. */
  private pending: string | null = null;
  /**
   * Why this draft has stopped asking, once the server has said so.
   *
   * Set from a refusal the server will keep repeating. Not authorisation -
   * clearing it would only produce a refused request - and it is per draft
   * because a new draft has a new session, a new allowance and a new answer.
   */
  private blocked: string | null = null;

  constructor(
    private readonly transport: StrategistTransport,
    private readonly policy: StrategistCallPolicy = DEFAULT_CALL_POLICY,
    private readonly ledger: UsageLedger = new UsageLedger(),
    /**
     * Metadata for the server's draft-session row. Not authorisation: the
     * server keys everything on the signed session cookie, and nothing here
     * can change what it decides.
     */
    private readonly session: { leagueId?: string | null } = {},
  ) {}

  subscribe(listener: (state: LiveStrategistState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  current(): LiveStrategistState {
    return this.state;
  }

  usage(draftId: string): UsageRecord | null {
    return this.ledger.get(draftId);
  }

  /**
   * The board changed. Decide whether to ask, and keep the screen honest.
   *
   * Called on every Sleeper update, which is often; almost all of them return
   * without spending anything.
   */
  async update(brief: DraftBrief | null): Promise<void> {
    if (brief === null) {
      this.abandon();
      this.publish(IDLE);
      return;
    }

    const fingerprint = brief.state.boardFingerprint;
    const selection = selectionKey(brief);

    /*
     * The board moved, so anything on screen describes a board that no longer
     * exists. It goes now rather than when the next answer arrives.
     *
     * Whether the request in flight is abandoned depends on whether this is
     * still OUR pick. A different selection means its answer can never be used;
     * the same selection with a changed board means the answer may still be
     * about a player who is gone, which the staleness gate will catch - and
     * abandoning it would only tempt us into paying again for the same pick.
     */
    if (this.state.fingerprint !== null && this.state.fingerprint !== fingerprint) {
      if (this.pending !== null && this.pending !== selection) this.abandon();
      this.publish(this.idleFor(brief, fingerprint));
    }

    if (!shouldRequest(brief, this.policy)) {
      if (this.state.phase !== 'idle') this.publish(this.idleFor(brief, fingerprint));
      return;
    }

    // The server has already said no in a way that will not change today.
    if (this.blocked !== null) {
      if (this.state.phase !== 'fallback') {
        this.publish({ ...this.idleFor(brief, fingerprint), phase: 'fallback', reason: this.blocked });
      }
      return;
    }

    // A request is already running for this pick. Polling must not start
    // another one on top of it.
    if (this.pending !== null) return;

    /*
     * One answer per selection of ours.
     *
     * A second call is only ever reached when the first completed without
     * producing advice. A call that answered - even with advice later discarded
     * as stale - has spent this pick, and so has one abandoned mid-flight.
     */
    const spent = this.spend.get(selection);
    if (spent && (spent.settled || spent.calls >= this.policy.maxCallsPerSelection)) return;
    this.spend.set(selection, { calls: (spent?.calls ?? 0) + 1, settled: false });

    const controller = new AbortController();
    this.inFlight = controller;
    this.pending = selection;
    this.publish({ ...this.idleFor(brief, fingerprint), phase: 'analyzing' });

    let result: StrategistTransportResult;
    try {
      result = await this.transport.advise({
        context: buildStrategistPromptContext(brief, { blind: true, compact: true }),
        boardPlayerIds: brief.candidates.map((candidate) => candidate.playerId),
        state: brief.state,
        leagueId: this.session.leagueId ?? null,
        isMock: brief.league.isMock,
        signal: controller.signal,
      });
    } catch (error) {
      // An abort is an expected outcome, not a failure worth showing - and the
      // selection stays spent, so nothing re-asks on its own.
      if (controller.signal.aborted) return;
      this.settle(selection, false);
      this.publish({
        ...this.idleFor(brief, fingerprint),
        phase: 'fallback',
        // A thrown transport error is our text, not theirs.
        reason: AI_UNAVAILABLE_NOTE,
        technicalDetail: error instanceof Error ? error.message : String(error),
      });
      return;
    } finally {
      if (this.inFlight === controller) {
        this.inFlight = null;
        this.pending = null;
      }
    }

    if (controller.signal.aborted) return;

    const usage = this.ledger.record(brief.state.draftId, result);

    if (result.refusal && TERMINAL_REFUSALS.has(result.refusal)) {
      /*
       * A refusal message is written for the drafter by `REFUSAL_MESSAGE` - "You
       * have used all of your AI drafts", not a fault code - so it is safe to
       * show. Anything unrecognised falls back to the neutral line.
       */
      this.blocked = result.error ?? AI_UNAVAILABLE_NOTE;
    }

    /*
     * The staleness gate, checked twice over: once against the board the
     * transport says it answered, which catches a reply routed from the wrong
     * draft, and once against the board we hold now, which catches the race.
     */
    const staleness = stalenessOf(result.state, brief.state);
    if (staleness !== null) {
      // Answered, then discarded. The pick is spent either way - re-asking
      // would pay twice for one selection.
      this.settle(selection, true);
      this.publish({
        ...IDLE,
        phase: 'fallback',
        fingerprint,
        reason: `Advice arrived about a different board (${staleness}).`,
        usage,
        entitlement: entitlementOf(result),
      });
      return;
    }

    const advice = result.response === null ? null : toLiveAdvice(result.response, brief, result.model);
    const decision = resolveStrategistDecision({
      brief,
      advice,
      responseProblems: result.problems,
      repair:
        result.attempts > 1
          ? {
              attempted: true,
              firstAttemptProblems: result.problems,
              succeeded: result.response !== null,
              attempts: result.attempts,
            }
          : null,
      latencyMs: result.latencyMs,
      strategistId: result.model,
    });

    /*
     * Settled when a response arrived at all - including one the guardrails
     * threw out. The strategist answered; the answer was unusable. Asking the
     * same question again would spend a second time on the same pick for the
     * same reasons.
     */
    this.settle(selection, result.response !== null);

    const applied = decision.final?.source === 'strategist';
    this.publish({
      phase: applied ? 'ready' : 'fallback',
      fingerprint,
      decision,
      /*
       * `describeOutcome`, NEVER `result.error`.
       *
       * This is the line that put a schema-validation dump on a customer's
       * screen. `result.error` is the transport's own text - written for us,
       * naming required fields and contract violations - and it used to take
       * precedence over the curated sentence. It now goes to `technicalDetail`,
       * which the draft UI does not render.
       */
      reason: applied ? null : describeOutcome(decision),
      technicalDetail: applied ? null : (result.error ?? null),
      usage,
      entitlement: entitlementOf(result),
    });
  }

  private settle(selection: string, settled: boolean): void {
    const spent = this.spend.get(selection);
    this.spend.set(selection, { calls: spent?.calls ?? 1, settled });
  }

  /**
   * An idle state that still remembers what the draft has cost.
   *
   * The ledger persists across turns, so the running total must too - clearing
   * it between selections would make the spend readout blink out exactly when
   * somebody is watching it.
   */
  private idleFor(brief: DraftBrief, fingerprint: string): LiveStrategistState {
    return { ...IDLE, fingerprint, usage: this.ledger.get(brief.state.draftId) };
  }

  /** Abandons the request in flight and marks its selection as spent. */
  private abandon(): void {
    if (this.pending !== null) this.settle(this.pending, true);
    this.inFlight?.abort();
    this.inFlight = null;
    this.pending = null;
  }

  /** Stop any request in flight, e.g. when the component unmounts. */
  abort(): void {
    this.abandon();
  }

  private publish(state: LiveStrategistState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

/**
 * Builds advice from a validated response, stamped with OUR board.
 *
 * The state comes from the brief rather than from the reply, so what the
 * strategist was looking at stays a fact about which brief we sent rather than
 * something a response could assert.
 */
function toLiveAdvice(
  response: StrategistResponse,
  brief: DraftBrief,
  model: string,
): StrategistAdvice {
  return {
    state: brief.state,
    primary: {
      playerId: response.recommendedPlayerId,
      reasoning: response.reasons.map((reason) => `${reason.code}: ${reason.detail}`).join(' '),
      reasonCodes: response.reasons.map((reason) => reason.code),
      confidence: clamp01(response.confidence / 100),
    },
    alternatives: response.alternatives.map((alternative) => ({
      playerId: alternative.playerId,
      reasoning: alternative.reason,
      reasonCodes: [],
      confidence: 0,
    })),
    roomRead: response.opponentsThatMatter.length
      ? response.opponentsThatMatter
          .map((opponent) => `Roster ${opponent.rosterId}: ${opponent.why}`)
          .join(' ')
      : null,
    confidence: clamp01(response.confidence / 100),
    model,
    urgency: response.urgency,
    reasons: response.reasons,
    strategy: response.strategy,
    firstSeedDeviationReason: response.firstSeedDeviationReason,
    strongestAlternativePlayerId: response.strongestAlternativePlayerId,
    strongestAlternativeWhy: response.strongestAlternativeWhy,
    strongestCounterargument: response.strongestCounterargument,
    whyRecommendationStillWins: response.whyRecommendationStillWins,
    expectedNextPickPlan: response.expectedNextPickPlan,
    opponentsThatMatter: response.opponentsThatMatter,
  };
}

/**
 * What the server said about this caller, when it said anything.
 *
 * Absent means accounts are switched off, which is a different state from
 * "Basic" and should not be drawn as one.
 */
function entitlementOf(
  result: StrategistTransportResult,
): LiveStrategistState['entitlement'] {
  if (!result.plan) return null;
  return {
    plan: result.plan,
    creditsRemaining: result.creditsRemaining ?? null,
    refusal: result.refusal ?? null,
  };
}

/**
 * Why a rejected suggestion was rejected, in the drafter's own terms.
 *
 * Every rejection used to read "suggested a selection that is not available",
 * which is true of exactly two of the nine reasons. Production QA caught it
 * saying so about a player who was plainly on the board and merely did not
 * fill the slot the roster still has to fill - which reads as a bug in the
 * product rather than a judgement about the pick.
 */
const REJECTION_NOTE: Record<GuardrailViolationCode, string> = {
  unknown_player: 'The strategist suggested a player we could not identify.',
  already_drafted: 'The strategist suggested someone who is already drafted.',
  not_in_candidate_pool: 'The strategist suggested a selection that is not available.',
  unusable_player_data: 'The strategist suggested a player we have no usable data for.',
  illegal_position: 'The strategist suggested a player who cannot fill any open slot.',
  no_roster_spots_remaining: 'The strategist suggested a player with nowhere left to go on your roster.',
  impossible_roster_construction:
    'Taking the strategist’s pick would leave a roster that cannot be filled legally.',
  must_fill_required_slot:
    'There are only enough picks left to fill your required slots, so the strategist’s pick was set aside.',
  meaningless_stack: 'The strategist suggested a stack that does not help this roster.',
};

/**
 * The one sentence a drafter sees when the strategist does not contribute.
 *
 * Deliberately identical for every technical cause. Whether the model returned
 * an empty tool call, the provider rate-limited us, or a repair failed is our
 * problem to read in the logs - to the person drafting they are the same event,
 * and the only thing that matters is the half of the sentence about Juancho.
 */
export const AI_UNAVAILABLE_NOTE =
  "AI analysis wasn't available for this pick. Juancho's recommendation is still active.";

/** A short, non-alarming note for the screen. Never an error banner. */
function describeOutcome(decision: StrategistDecision): string {
  switch (decision.outcome) {
    case 'ai_malformed':
    case 'ai_unavailable':
      // One line, whatever the technical cause. The detail is in the logs.
      return AI_UNAVAILABLE_NOTE;
    case 'ai_rejected': {
      const violation: GuardrailViolationCode | undefined =
        decision.audit.guardrail?.violations[0]?.code;
      return violation
        ? REJECTION_NOTE[violation]
        : 'The strategist suggested a selection that is not available.';
    }
    case 'ai_stale':
      return 'The board moved before the strategist answered.';
    default:
      return 'Showing the deterministic recommendation.';
  }
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
