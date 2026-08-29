/**
 * The card's opening sentences, composed from the engine's own components.
 *
 * Deliberately mechanical. Each clause is licensed by a specific number, so
 * there is no path by which the card can claim something the engine did not
 * find - which matters more here than anywhere else in the product, because
 * this is the text somebody drafts on without reading further.
 *
 * The four questions, in the order a drafter asks them: who should I draft, why,
 * what happens if I wait, and what else could I take.
 */
import type { DraftRecommendation } from '../engine/draft/types';
import { describeAvailability, describeTierDepth, type TierDescription } from './plain-language';

export interface PlainVerdict {
  /** "Draft Jordan Addison" */
  headline: string;
  /** One sentence, no numbers a reader has to interpret. */
  why: string;
  /** "47% chance he's still available at your next pick" */
  ifYouWait: string;
  /** "Alternative: Croskey-Merritt if you prefer RB depth" */
  alternative: string | null;
  /** How thin his position is, in words. Null when nothing is known about it. */
  position: TierDescription | null;
}

export function plainVerdict({
  name,
  engine,
  picksUntilTurn,
  alternative,
  tierGap,
  tierSurvives,
}: {
  name: string;
  engine: DraftRecommendation;
  picksUntilTurn: number | null;
  alternative: DraftRecommendation | null;
  tierGap: number | null;
  /** Chance somebody of this quality is still there at our turn. */
  tierSurvives: number | null;
}): PlainVerdict {
  const position = engine.player.position;
  const insight = engine.insight;
  const fillsStarter =
    engine.components.marginalStartingValue > 0.5 &&
    insight.startersFilled < insight.startersRequired;

  /*
   * What the pick DOES, gated on the only number that answers it. An earlier
   * version asked the saturation label instead, and a roster with three backs
   * against two starting slots came back "medium" - so a pick that improved the
   * lineup by nothing was described as the strongest value on the board rather
   * than as the bench pick it was.
   */
  const base = fillsStarter
    ? `He fills your open ${position} spot`
    : engine.components.marginalStartingValue > 0.5
      ? `He improves your starting lineup more than anything else available`
      : `Your starting spots are already full, so this is about the best value left for your bench`;

  const depth = describeTierDepth({
    position,
    playersRemaining: engine.playersRemainingInTier,
    gapAfterTier: tierGap,
    weStartOne: insight.openStartingSlots > 0,
    chanceOneRemains: tierSurvives,
  });

  /*
   * The timing clause. `opportunityCost` is what the engine believes waiting
   * costs, in final-roster points; above the threshold it has decided the
   * sequence matters, and below it the engine's own exception message usually
   * explains why it picked him anyway.
   */
  const urgent = engine.components.opportunityCost > 1.5;
  const timing = urgent
    ? ', and waiting a turn for him is likely to cost you'
    : insight.exceptionalReason
      ? ''
      : engine.playersRemainingInTier <= 2
        ? `, and only ${engine.playersRemainingInTier} comparable ${position}${engine.playersRemainingInTier === 1 ? '' : 's'} are left`
        : '';

  const why = insight.exceptionalReason
    ? `${base}. ${insight.exceptionalReason}`
    : `${base}${timing}.`;

  return {
    headline: `Draft ${name}`,
    why,
    ifYouWait: describeAvailability({
      probability: engine.availableNextPickProbability,
      modeled: engine.availableNextPickProbability !== null,
      picksUntilTurn,
    }),
    alternative: alternative
      ? `Alternative: ${alternative.player.name}${describeAlternative(alternative, engine)}`
      : null,
    position: depth,
  };
}

/** Why somebody might reasonably take the other one instead. */
function describeAlternative(
  alternative: DraftRecommendation,
  engine: DraftRecommendation,
): string {
  if (alternative.player.position !== engine.player.position) {
    return ` if you prefer ${alternative.player.position} depth`;
  }
  if (
    alternative.availableNextPickProbability !== null &&
    engine.availableNextPickProbability !== null &&
    alternative.availableNextPickProbability < engine.availableNextPickProbability - 10
  ) {
    return ' if you would rather secure the scarcer of the two';
  }
  if (alternative.raw.projectedPoints > engine.raw.projectedPoints) {
    return ' if you would rather have the higher projection';
  }
  return '';
}

