/**
 * The AI Strategist layer.
 *
 * Nothing here runs unless a `StrategistClient` is supplied, and none of it is
 * wired into the live draft path yet: the deterministic engine's behaviour is
 * unchanged whether this module is imported or not.
 */
export { buildDraftBrief } from './brief';
export type { BuildDraftBriefInput } from './brief';
export { buildCandidates, DEFAULT_CANDIDATE_POOL } from './candidates';
export type { CandidatePoolOptions } from './candidates';
export { buildTeamModels } from './teams';
export {
  buildDraftStateVersion,
  fingerprintBoard,
  isSameDraftState,
  stalenessOf,
} from './state-version';
export type { StalenessReason } from './state-version';
export {
  validateStrategistPick,
  CERTAIN_SURVIVAL,
  KNOWN_REASON_CODES,
  LOW_CONFIDENCE,
  NOTABLE_PLAN_LOSS,
  NOTABLE_REACH_RANKS,
} from './guardrails';
export type {
  GuardrailConcern,
  GuardrailConcernCode,
  GuardrailResult,
  GuardrailViolation,
  GuardrailViolationCode,
} from './guardrails';
export { resolveStrategistDecision, summarizeAudit } from './audit';
export type {
  ChosenPlayer,
  ResolveStrategistInput,
  StrategistAuditRecord,
  StrategistDecision,
  StrategistOutcome,
} from './audit';
export * from './types';
