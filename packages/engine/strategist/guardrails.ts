/**
 * What the strategist is not allowed to do.
 *
 * The deterministic engine is a SAFETY layer here, not the strategic authority.
 * That distinction decides everything about this file: a recommendation is
 * blocked only when it is objectively invalid - a player who is gone, a move
 * that cannot legally be made, a body at a position that could never reach the
 * lineup. It is never blocked for being a strategic judgement the deterministic
 * engine disagrees with.
 *
 * That is deliberate and it is the point of the whole layer. Rejecting a pick
 * because it reaches further than our First Seed deviation threshold, or
 * because its stated reason is not one of the six words `deviation.ts` knows,
 * or because our own greedy completed-roster simulation preferred somebody
 * else, would reduce the strategist to an expensive way of reproducing the
 * engine. Those disagreements are the reason it exists, so they are RECORDED as
 * concerns and passed through.
 *
 * Everything here is pure and reads only the brief, so a stored audit record
 * can be revalidated years later without the engine that produced it.
 */
import type { Position } from '../../players/types';
import { solveBestLineup, type LineupPlayer } from '../draft/lineup';
import type {
  BriefCandidate,
  DraftBrief,
  StrategistPick,
} from './types';

/** Blocking. Every one of these means the pick could not actually be made. */
export type GuardrailViolationCode =
  | 'unknown_player'
  | 'already_drafted'
  | 'not_in_candidate_pool'
  | 'unusable_player_data'
  | 'illegal_position'
  | 'no_roster_spots_remaining'
  | 'impossible_roster_construction'
  | 'meaningless_stack';

/**
 * Non-blocking. These are strategic disagreements, recorded so the layer can be
 * audited, and deliberately NOT reasons to reject.
 */
export type GuardrailConcernCode =
  | 'reaches_past_first_seed'
  | 'deterministic_prefers_other'
  | 'outside_juancho_shortlist'
  | 'unrecognized_reason_code'
  | 'contradicts_survival_estimate'
  | 'low_confidence';

export interface GuardrailViolation {
  code: GuardrailViolationCode;
  playerId: string;
  message: string;
}

export interface GuardrailConcern {
  code: GuardrailConcernCode;
  playerId: string;
  message: string;
  /** Signed magnitude where one exists - ranks reached, plan points given up. */
  magnitude: number | null;
}

export interface GuardrailResult {
  ok: boolean;
  violations: GuardrailViolation[];
  concerns: GuardrailConcern[];
}

/**
 * The reason vocabulary the deterministic audit understands.
 *
 * A strategist reason outside it is noted so new vocabulary can be spotted and
 * adopted, never rejected: the strategist is expected to have reasons the
 * deterministic engine does not have words for.
 */
export const KNOWN_REASON_CODES = new Set([
  'followed_first_seed',
  'positional_saturation',
  'starter_need',
  'tier_cliff',
  'returns_to_us',
  'opportunity_cost',
  'higher_projection',
]);

/** Reaching this far past the board is worth recording. Never blocking. */
export const NOTABLE_REACH_RANKS = 10;
/** Giving up this much final-roster value is worth recording. Never blocking. */
export const NOTABLE_PLAN_LOSS = 10;
/** Below this, the strategist's own confidence is worth recording. */
export const LOW_CONFIDENCE = 0.4;
/** A player this likely to survive cannot be urgent. */
export const CERTAIN_SURVIVAL = 90;

export function validateStrategistPick(
  pick: StrategistPick,
  brief: DraftBrief,
): GuardrailResult {
  const violations: GuardrailViolation[] = [];
  const concerns: GuardrailConcern[] = [];
  const { playerId } = pick;
  const violate = (code: GuardrailViolationCode, message: string) =>
    violations.push({ code, playerId, message });
  const note = (code: GuardrailConcernCode, message: string, magnitude: number | null = null) =>
    concerns.push({ code, playerId, message, magnitude });

  /* ---------------------------------------------------- does he exist, is he free */

  if (brief.room.allDraftedPlayerIds.includes(playerId)) {
    violate('already_drafted', 'This player has already been selected in this draft.');
    return { ok: false, violations, concerns };
  }

  const candidate = brief.candidates.find((entry) => entry.playerId === playerId);
  if (!candidate) {
    // Everything the strategist was shown is in the pool, so a name outside it
    // was either invented or is unavailable. Both are the same failure.
    violate(
      'not_in_candidate_pool',
      'This player is not in the available candidate pool the strategist was given.',
    );
    return { ok: false, violations, concerns };
  }
  if (!candidate.name || candidate.position === 'UNKNOWN') {
    violate('unknown_player', 'This player could not be identified in the player pool.');
  }
  if (!Number.isFinite(candidate.juancho.projectedPoints)) {
    violate('unusable_player_data', 'This player has no usable projection and cannot be valued.');
  }

  /* ---------------------------------------------------------------- is it legal */

  if (brief.constraints.rosterSpotsRemaining <= 0) {
    violate('no_roster_spots_remaining', 'There are no selections left to make.');
  }

  const blocked = brief.constraints.blockedPositions.find(
    (entry) => entry.position === candidate.position,
  );
  if (blocked) {
    // A blocked single-slot position is meaningless stacking specifically; a
    // blocked kicker is an illegal selection. They are different failures and
    // an audit needs to tell them apart.
    const capacity = brief.constraints.usableCapacity[candidate.position];
    const held = heldAt(brief, candidate.position);
    if (capacity !== undefined && held >= capacity) {
      violate('meaningless_stack', blocked.reason);
    } else {
      violate('illegal_position', blocked.reason);
    }
  }

  if (
    !brief.constraints.kickersAndDefensesAllowed &&
    (candidate.position === 'K' || candidate.position === 'DEF')
  ) {
    violate(
      'illegal_position',
      'Kickers and defenses are only selected in the closing rounds of the draft.',
    );
  }

  if (leavesLineupUnfillable(brief, candidate)) {
    violate(
      'impossible_roster_construction',
      'Taking this player leaves more required starting slots empty than there are selections remaining.',
    );
  }

  /* --------------------------------------- disagreements, recorded not blocked */

  const reach = candidate.firstSeed.rankGapFromBestAvailable;
  if (reach !== null && reach >= NOTABLE_REACH_RANKS) {
    note(
      'reaches_past_first_seed',
      `Reaches ${reach} ranks past First Seed's best available player.`,
      reach,
    );
  }

  const planDelta = candidate.juancho.planValueVsRecommended;
  if (planDelta !== null && planDelta < -NOTABLE_PLAN_LOSS) {
    note(
      'deterministic_prefers_other',
      `Juancho's completed-roster simulation rates this ${Math.abs(planDelta).toFixed(1)} points below its own preferred pick.`,
      planDelta,
    );
  }

  if (
    !candidate.inclusionReasons.includes('juancho_shortlist') &&
    !candidate.inclusionReasons.includes('juancho_recommendation')
  ) {
    note(
      'outside_juancho_shortlist',
      'Juancho never planned a completed roster around this player, so no plan comparison exists.',
    );
  }

  for (const code of pick.reasonCodes) {
    if (KNOWN_REASON_CODES.has(code)) continue;
    note('unrecognized_reason_code', `Reason "${code}" is outside the deterministic vocabulary.`);
  }

  const survival = candidate.survival.probability;
  if (
    survival !== null &&
    survival >= CERTAIN_SURVIVAL &&
    candidate.survival.confidence === 'high' &&
    /\b(urgent|now|last chance|won'?t last|gone)\b/i.test(pick.reasoning)
  ) {
    note(
      'contradicts_survival_estimate',
      `Reasoning implies urgency, but Juancho puts him at ${survival}% to survive to our next selection.`,
      survival,
    );
  }

  if (pick.confidence < LOW_CONFIDENCE) {
    note('low_confidence', `The strategist's own confidence is ${pick.confidence}.`, pick.confidence);
  }

  return { ok: violations.length === 0, violations, concerns };
}

/* ------------------------------------------------------------------ helpers */

function heldAt(brief: DraftBrief, position: Position): number {
  return brief.ourTeam.players.filter((player) => player.position === position).length;
}

/**
 * Would this pick leave a lineup we cannot legally field?
 *
 * Only DEDICATED starting slots count: an empty flex is a bad roster, not an
 * invalid one.
 *
 * The second half of the test is what makes this honest. A pick is only the
 * CAUSE of an unfillable lineup if some other available pick would have avoided
 * it - so the deficit is compared against the best any selection could manage,
 * which is one fewer hole when a player at a missing position is still on the
 * board. Two rounds left and three slots empty is already lost, and blocking
 * every candidate in that position would leave the strategist unable to answer
 * at all.
 *
 * Deliberately NOT measured against the deterministic recommendation: that
 * would make this guardrail inherit whatever the engine happened to prefer,
 * including a pick that is itself doomed.
 */
function leavesLineupUnfillable(brief: DraftBrief, candidate: BriefCandidate): boolean {
  const picksLeftAfter = brief.draft.picksRemaining - 1;
  if (picksLeftAfter < 0) return false;

  const roster: LineupPlayer[] = brief.ourTeam.players.map((player) => ({
    playerId: player.playerId,
    position: player.position,
    projection: player.projectedPoints,
  }));
  const dedicatedHoles = (players: LineupPlayer[]) =>
    solveBestLineup(players, brief.constraints.slots)
      .unfilled.filter((hole) => DEDICATED_SLOTS.has(hole.slot as string))
      .reduce((sum, hole) => sum + hole.count, 0);

  const holesAfterThisPick = dedicatedHoles([
    ...roster,
    {
      playerId: candidate.playerId,
      position: candidate.position,
      projection: candidate.juancho.projectedPoints,
    },
  ]);
  if (holesAfterThisPick <= picksLeftAfter) return false;

  // The best any pick could do: fill one of the empty slots, if anyone who
  // could is still available.
  const missing = new Set(
    brief.constraints.mustFillBeforeDraftEnds
      .filter((entry) => entry.count > 0)
      .map((entry) => entry.position),
  );
  const someoneCanFill = brief.candidates.some((entry) => missing.has(entry.position));
  const bestAchievable = someoneCanFill
    ? Math.max(0, holesAfterThisPick - 1)
    : holesAfterThisPick;

  // Already unavoidable: this pick is not what caused it.
  return bestAchievable <= picksLeftAfter;
}

const DEDICATED_SLOTS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF']);
