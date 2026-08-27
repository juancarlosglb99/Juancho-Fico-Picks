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
}

export interface StrategistTransport {
  advise(input: {
    context: StrategistPromptContext;
    boardPlayerIds: string[];
    state: DraftStateVersion;
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
export interface StrategistCallPolicy {
  /** Begin analysing once our selection is this close. */
  analyzeWithin: number;
  /** Always ask again when we are on the clock, even if an answer exists. */
  refreshOnTheClock: boolean;
  /** Set false to stop calling entirely, for a cap or a kill switch. */
  enabled: boolean;
}

export const DEFAULT_CALL_POLICY: StrategistCallPolicy = {
  analyzeWithin: 3,
  refreshOnTheClock: true,
  enabled: true,
};

export function shouldRequest(
  brief: DraftBrief,
  policy: StrategistCallPolicy,
): boolean {
  if (!policy.enabled) return false;
  if (brief.draft.isOurSelection) return true;
  const until = brief.draft.picksUntilOurNextSelection;
  return until !== null && until <= policy.analyzeWithin;
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
  /** Set on fallback, for a quiet note rather than an error banner. */
  reason: string | null;
  usage: UsageRecord | null;
}

const IDLE: LiveStrategistState = {
  phase: 'idle',
  fingerprint: null,
  decision: null,
  reason: null,
  usage: null,
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
  /** Fingerprints already asked about, so an unchanged board is never re-billed. */
  private readonly asked = new Set<string>();

  constructor(
    private readonly transport: StrategistTransport,
    private readonly policy: StrategistCallPolicy = DEFAULT_CALL_POLICY,
    private readonly ledger: UsageLedger = new UsageLedger(),
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
      this.abort();
      this.publish(IDLE);
      return;
    }

    const fingerprint = brief.state.boardFingerprint;

    // The board moved: whatever is in flight is about to be stale, and whatever
    // is on screen already is.
    if (this.state.fingerprint !== null && this.state.fingerprint !== fingerprint) {
      this.abort();
      this.publish({ ...IDLE, fingerprint });
    }

    if (!shouldRequest(brief, this.policy)) {
      if (this.state.phase !== 'idle') this.publish({ ...IDLE, fingerprint });
      return;
    }

    // Asked about this exact board already - a poll that changed nothing must
    // not cost anything.
    if (this.asked.has(fingerprint)) return;
    this.asked.add(fingerprint);

    const controller = new AbortController();
    this.inFlight = controller;
    this.publish({ ...IDLE, phase: 'analyzing', fingerprint });

    let result: StrategistTransportResult;
    try {
      result = await this.transport.advise({
        context: buildStrategistPromptContext(brief, { blind: true, compact: true }),
        boardPlayerIds: brief.candidates.map((candidate) => candidate.playerId),
        state: brief.state,
        signal: controller.signal,
      });
    } catch (error) {
      // An abort is an expected outcome, not a failure worth showing.
      if (controller.signal.aborted) return;
      this.publish({
        ...IDLE,
        phase: 'fallback',
        fingerprint,
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    } finally {
      if (this.inFlight === controller) this.inFlight = null;
    }

    // Aborted while we waited: the answer is about a board nobody is looking at.
    if (controller.signal.aborted) return;

    const usage = this.ledger.record(brief.state.draftId, result);

    /*
     * The staleness gate, checked twice over.
     *
     * Once against the board the transport says it answered - which catches a
     * reply routed from the wrong draft or the wrong pick - and once against
     * the board we are holding now, which catches the ordinary race where the
     * room moved while we waited.
     */
    const staleness = stalenessOf(result.state, brief.state);
    if (staleness !== null) {
      this.publish({
        ...IDLE,
        phase: 'fallback',
        fingerprint,
        reason: `Advice arrived about a different board (${staleness}).`,
        usage,
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

    const applied = decision.final?.source === 'strategist';
    this.publish({
      phase: applied ? 'ready' : 'fallback',
      fingerprint,
      decision,
      reason: applied ? null : (result.error ?? describeOutcome(decision)),
      usage,
    });
  }

  /** Stop any request in flight, e.g. when the component unmounts. */
  abort(): void {
    this.inFlight?.abort();
    this.inFlight = null;
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

/** A short, non-alarming note for the screen. Never an error banner. */
function describeOutcome(decision: StrategistDecision): string {
  switch (decision.outcome) {
    case 'ai_malformed':
      return 'The strategist did not answer in the required form.';
    case 'ai_rejected':
      return 'The strategist suggested a selection that is not available.';
    case 'ai_stale':
      return 'The board moved before the strategist answered.';
    case 'ai_unavailable':
      return 'The strategist is unavailable.';
    default:
      return 'Showing the deterministic recommendation.';
  }
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
