/**
 * Which recommendation is actually shown, and a record of why.
 *
 * Two questions get answered here. The first is a race: advice arrives about a
 * board that may have moved, and must never be applied to a different one. The
 * second is accountability - when a questionable pick is reported days later,
 * the only useful answer to "why did the strategist take X over First Seed's Y"
 * is the exact state it was looking at, what it said, what the deterministic
 * engine said, and what the guardrails made of it.
 *
 * So every decision produces a record containing all of that. It is verbose on
 * purpose: a record that omits the brief cannot be re-examined, and a record
 * that cannot be re-examined is a log line, not an audit.
 */
import type { Position } from '../../players/types';
import { validateStrategistPick, type GuardrailResult } from './guardrails';
import { stalenessOf, type StalenessReason } from './state-version';
import type { DraftBrief, StrategistAdvice, StrategistPick } from './types';

export type StrategistOutcome =
  /** No strategist ran, or it returned nothing. */
  | 'ai_unavailable'
  /** It answered, but not in the shape it was asked to answer in. */
  | 'ai_malformed'
  /** It answered about a board that no longer exists. */
  | 'ai_stale'
  /** It agreed with the deterministic engine. */
  | 'ai_confirmed'
  /** It disagreed, legally, and its pick is shown. */
  | 'ai_override'
  /** Its first choice was invalid; one of its alternatives is shown. */
  | 'ai_alternative'
  /** Its choices were all invalid; the deterministic pick is shown. */
  | 'ai_rejected';

export interface ChosenPlayer {
  playerId: string;
  name: string;
  position: Position;
  source: 'deterministic' | 'strategist';
}

export interface StrategistAuditRecord {
  /** The exact board this decision was made on. */
  state: DraftBrief['state'];
  /** The exact brief the strategist was given. */
  brief: DraftBrief;
  deterministic: DraftBrief['deterministic']['recommended'];
  advice: StrategistAdvice | null;
  adviceConfidence: number | null;
  /**
   * Why a response was thrown away before it became advice.
   *
   * Recorded rather than merely logged: a malformed answer is a fact about the
   * strategist that a later review needs, and it is invisible from the outside
   * because the deterministic pick is shown either way.
   */
  responseProblems: ResponseValidationProblem[];
  /** Whether the response had to be repaired, and what was wrong first time. */
  repair: RepairRecord | null;
  /** The strategist's structured reasons, kept verbatim. */
  reasons: { playerId: string; reasonCodes: string[]; reasoning: string }[];
  guardrail: GuardrailResult | null;
  /** Guardrail results for the alternatives, whether or not one was used. */
  alternativeGuardrails: { playerId: string; result: GuardrailResult }[];
  staleness: StalenessReason | null;
  outcome: StrategistOutcome;
  final: ChosenPlayer | null;
  latencyMs: number | null;
  strategistId: string | null;
}

export interface StrategistDecision {
  outcome: StrategistOutcome;
  final: ChosenPlayer | null;
  audit: StrategistAuditRecord;
}

/**
 * A structural failure in the strategist's response.
 *
 * Kept structurally identical to the validator's own type but declared here so
 * the audit record never has to import the Anthropic module - which reads the
 * API key and must not be reachable from a browser bundle.
 */
export interface ResponseValidationProblem {
  code: string;
  path: string;
  message: string;
}

/**
 * A response that failed validation once and was asked again.
 *
 * Recorded because a repaired answer and a first-time answer are not the same
 * event. How often the model needs correcting is a property worth watching,
 * and it is invisible from the outside once the second attempt succeeds.
 */
export interface RepairRecord {
  attempted: boolean;
  firstAttemptProblems: ResponseValidationProblem[];
  succeeded: boolean;
  attempts: number;
}

export interface ResolveStrategistInput {
  brief: DraftBrief;
  /** Null whenever no strategist ran, it failed, or it was aborted. */
  advice: StrategistAdvice | null;
  /**
   * Set when a response arrived but failed validation.
   *
   * Distinguishes "the strategist answered badly" from "the strategist never
   * answered", which need different responses: one is a contract problem worth
   * investigating, the other is an outage.
   */
  responseProblems?: ResponseValidationProblem[];
  /** Set whenever a first attempt failed validation, repaired or not. */
  repair?: RepairRecord | null;
  latencyMs?: number | null;
  strategistId?: string | null;
  /**
   * Whether an invalid first choice may fall through to an alternative.
   *
   * Off by default. A strategist whose primary pick is objectively invalid has
   * demonstrated it is reasoning about something other than this board, and
   * quietly promoting its second answer hides that. The deterministic engine is
   * the safety layer, so the safe default is to use it.
   */
  allowAlternativeFallback?: boolean;
}

export function resolveStrategistDecision(
  input: ResolveStrategistInput,
): StrategistDecision {
  const { brief, advice } = input;
  const deterministic = brief.deterministic.recommended;
  const fallback: ChosenPlayer | null = deterministic
    ? {
        playerId: deterministic.playerId,
        name: deterministic.name,
        position: deterministic.position,
        source: 'deterministic',
      }
    : null;

  const base = {
    state: brief.state,
    brief,
    deterministic,
    advice,
    adviceConfidence: advice?.confidence ?? null,
    responseProblems: input.responseProblems ?? [],
    repair: input.repair ?? null,
    reasons:
      advice === null
        ? []
        : [advice.primary, ...advice.alternatives].map((pick) => ({
            playerId: pick.playerId,
            reasonCodes: pick.reasonCodes,
            reasoning: pick.reasoning,
          })),
    latencyMs: input.latencyMs ?? null,
    strategistId: input.strategistId ?? null,
  };

  if (advice === null) {
    return decide({
      ...base,
      guardrail: null,
      alternativeGuardrails: [],
      staleness: null,
      // A response that arrived and was rejected is a different event from one
      // that never arrived, and only the first is worth investigating.
      outcome: (input.responseProblems?.length ?? 0) > 0 ? 'ai_malformed' : 'ai_unavailable',
      final: fallback,
    });
  }

  /*
   * The race, settled before anything else.
   *
   * Advice about a board that has moved is not partially useful - the players
   * it weighed may be gone and the teams it reasoned about may already have
   * picked - so it is discarded whole rather than salvaged.
   */
  const staleness = stalenessOf(advice.state, brief.state);
  if (staleness !== null) {
    return decide({
      ...base,
      guardrail: null,
      alternativeGuardrails: [],
      staleness,
      outcome: 'ai_stale',
      final: fallback,
    });
  }

  const primary = validateStrategistPick(advice.primary, brief);
  const alternativeGuardrails = advice.alternatives.map((pick) => ({
    playerId: pick.playerId,
    result: validateStrategistPick(pick, brief),
  }));

  if (primary.ok) {
    const chosen = chosenFrom(advice.primary, brief);
    return decide({
      ...base,
      guardrail: primary,
      alternativeGuardrails,
      staleness: null,
      outcome:
        deterministic && deterministic.playerId === advice.primary.playerId
          ? 'ai_confirmed'
          : 'ai_override',
      final: chosen ?? fallback,
    });
  }

  if (input.allowAlternativeFallback) {
    const rescued = advice.alternatives.find(
      (pick) => alternativeGuardrails.find((entry) => entry.playerId === pick.playerId)?.result.ok,
    );
    if (rescued) {
      const chosen = chosenFrom(rescued, brief);
      if (chosen) {
        return decide({
          ...base,
          guardrail: primary,
          alternativeGuardrails,
          staleness: null,
          outcome: 'ai_alternative',
          final: chosen,
        });
      }
    }
  }

  return decide({
    ...base,
    guardrail: primary,
    alternativeGuardrails,
    staleness: null,
    outcome: 'ai_rejected',
    final: fallback,
  });
}

function chosenFrom(pick: StrategistPick, brief: DraftBrief): ChosenPlayer | null {
  const candidate = brief.candidates.find((entry) => entry.playerId === pick.playerId);
  if (!candidate) return null;
  return {
    playerId: candidate.playerId,
    name: candidate.name,
    position: candidate.position,
    source: 'strategist',
  };
}

function decide(audit: StrategistAuditRecord): StrategistDecision {
  return { outcome: audit.outcome, final: audit.final, audit };
}

/**
 * The audit record without the brief.
 *
 * The brief is what makes a record re-examinable and it is also most of its
 * size. Anything writing many records to one place wants this; anything
 * investigating a single reported pick wants the whole thing.
 */
export function summarizeAudit(
  record: StrategistAuditRecord,
): Omit<StrategistAuditRecord, 'brief'> & { briefVersion: number } {
  const { brief, ...rest } = record;
  return { ...rest, briefVersion: brief.briefVersion };
}
