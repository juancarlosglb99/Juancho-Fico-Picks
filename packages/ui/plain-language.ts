/**
 * The product's vocabulary, translated out of the engine's.
 *
 * A drafter knows fantasy football. He does not know what a tier number is in
 * this codebase, what "simGap" measures, or why a positional need is 2.9. Every
 * one of those is a real internal quantity and every one of them is useless on
 * a screen with a clock running, so this module is the single place where an
 * engine quantity becomes a sentence a person can act on.
 *
 * The rule it follows: say the CONCLUSION, not the measurement. "8 similarly
 * rated receivers remain" is a conclusion. "Tier 12 · 8 left" is a measurement
 * that asks the reader to do the engine's job. The measurement is still there,
 * one click away, for anyone who wants to check the working.
 */
import type { Confidence } from '../engine/context/types';
import type { NeedLevel } from '../engine/draft/roster-state';
import type { Position } from '../players/types';

/** What to do about a position, in the order a drafter would say it. */
export type PositionUrgency = 'no_rush' | 'consider_now' | 'last_chance';

export interface TierDescription {
  /** "8 similarly rated WRs remain" */
  supply: string;
  /** "No major drop-off yet" / "Big quality drop after him" */
  dropOff: string;
  /** The line a card ends on. */
  advice: string;
  urgency: PositionUrgency;
}

/**
 * How thin a position is, without ever saying the word "tier".
 *
 * Two facts drive it and both are already computed: how many comparable players
 * are left, and how far the board falls after them. A drop of a few points is
 * not a cliff even with one player left; a drop of thirty is, even with three.
 */
const BIG_DROP_POINTS = 20;
const NOTABLE_DROP_POINTS = 8;

export function describeTierDepth({
  position,
  playersRemaining,
  gapAfterTier,
  weStartOne,
  chanceOneRemains,
}: {
  position: Position;
  playersRemaining: number;
  /** Projected points between this group and the next one down. */
  gapAfterTier: number | null;
  /** Whether we still have a starting slot open at this position. */
  weStartOne: boolean;
  /**
   * Chance the group still holds somebody when our turn comes, when known.
   *
   * Without it, a thin group with a steep drop always reads as urgent - which
   * told a drafter at pick one that a quarterback was his last chance while the
   * simulation had just said the group survives 99% of the time. Scarcity and
   * urgency are different questions and only this answers the second.
   */
  chanceOneRemains?: number | null;
}): TierDescription {
  const plural = playersRemaining === 1 ? '' : 's';
  const supply =
    playersRemaining <= 0
      ? `No comparable ${position}s left`
      : playersRemaining === 1
        ? `Only 1 ${position} of this quality left`
        : `${playersRemaining} similarly rated ${position}${plural} remain`;

  const big = gapAfterTier !== null && gapAfterTier >= BIG_DROP_POINTS;
  const notable = gapAfterTier !== null && gapAfterTier >= NOTABLE_DROP_POINTS;
  const dropOff =
    gapAfterTier === null
      ? 'Drop-off unknown'
      : big
        ? 'Big quality drop after him'
        : notable
          ? 'Noticeable drop after him'
          : 'No major drop-off yet';

  const scarce: PositionUrgency =
    playersRemaining <= 1 && big
      ? 'last_chance'
      : (playersRemaining <= 2 && notable) || playersRemaining <= 1
        ? 'consider_now'
        : 'no_rush';

  /*
   * Scarcity says how thin the group is; availability says whether that
   * matters before our next turn. A group that survives nine times out of ten
   * is not a last chance however steep the drop behind it.
   */
  const urgency: PositionUrgency =
    chanceOneRemains === null || chanceOneRemains === undefined
      ? scarce
      : chanceOneRemains >= 80
        ? 'no_rush'
        : chanceOneRemains >= 45
          ? (scarce === 'no_rush' ? 'no_rush' : 'consider_now')
          : scarce;

  const likelyToLast = (chanceOneRemains ?? 0) >= 80;
  const advice =
    urgency === 'last_chance'
      ? weStartOne
        ? 'Last good chance at this position'
        : 'Last of this quality on the board'
      : urgency === 'consider_now'
        ? 'Consider taking one now'
        : likelyToLast
          ? 'Should still be there at your turn'
          : 'No need to rush';

  return { supply, dropOff, advice, urgency };
}

/**
 * A survival figure, or an honest admission that there is not one.
 *
 * Never "100%" from a default: an estimate that was not made is reported as
 * missing, because a drafter reading a confident number assumes something
 * checked it.
 */
export function describeAvailability({
  probability,
  modeled,
  picksUntilTurn,
}: {
  probability: number | null;
  modeled: boolean;
  picksUntilTurn: number | null;
}): string {
  if (picksUntilTurn === 0) return 'You pick again immediately, so he cannot be taken';
  if (picksUntilTurn === null) return 'This is your last selection';
  if (!modeled || probability === null) return 'Not enough simulation data';
  return `${Math.round(probability)}% chance he's still available at your next pick`;
}

/** A word, not a decimal. `0.8999999` is never a thing a person should read. */
export function describeStrength(value: number, scale = 100): 'High' | 'Medium' | 'Low' {
  const share = scale === 0 ? 0 : value / scale;
  if (share >= 0.66) return 'High';
  if (share >= 0.33) return 'Medium';
  return 'Low';
}

export function describeConfidence(confidence: Confidence): string {
  return confidence === 'high' ? 'High' : confidence === 'medium' ? 'Medium' : 'Low';
}

/** "critical" is an engine label; a person would say how badly they need one. */
export function describeNeed(level: NeedLevel, openStartingSlots: number): string {
  const open = Math.round(openStartingSlots);
  if (open >= 2) return `You need ${open} starters here`;
  if (open === 1) return 'You still need a starter here';
  if (level === 'critical' || level === 'high') return 'Thin here';
  if (level === 'medium') return 'Could use depth';
  return 'Well covered';
}

export type EdgeStrength = 'slight' | 'moderate' | 'strong';

/**
 * How much better one option is than another, in words.
 *
 * The thresholds are in final-roster points, the unit the engine ranks in. A
 * finished roster is worth well over a thousand of them, so a gap of five is a
 * coin flip dressed up as a decision and should say so.
 */
export function describeEdge(pointsDifference: number): EdgeStrength {
  const gap = Math.abs(pointsDifference);
  if (gap >= 25) return 'strong';
  if (gap >= 8) return 'moderate';
  return 'slight';
}

/** Points, for a reader rather than a spreadsheet. */
export function describePoints(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${Math.round(value)}`;
}
