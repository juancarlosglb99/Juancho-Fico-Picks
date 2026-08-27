/**
 * The shape the strategist must answer in.
 *
 * Structured output rather than prose, enforced by a forced tool call: a model
 * that can reply in sentences will eventually reply in sentences, and a parser
 * for those is a permanent source of silent failure. The schema also does real
 * work on the reasoning - asking for `expectedNextPickPlan`,
 * `strongestCounterargument` and `opponentsThatMatter` by name forces the
 * sequence, the objection and the room to be reasoned about rather than
 * mentioned.
 *
 * Two variants of the same contract. They differ only in how much prose each
 * field may carry and how many entries the arrays hold - every field, every
 * requirement and every enum is identical, because the point of the concise
 * variant is a shorter answer to the same question, not a different question.
 * Both come out of one factory so they cannot drift apart.
 *
 * On the two kinds of limit here: the DESCRIPTIONS do the shaping ("one short
 * sentence"), while `maxLength` is a genuine ceiling that the validator
 * enforces exactly. Setting the ceiling at the target would manufacture
 * rejections over a stray clause; setting it well above lets the description
 * steer while still catching a runaway.
 */

/** Ceilings for one variant of the contract. */
interface ContractLimits {
  strategy: number;
  reasonCode: number;
  reasonDetail: number;
  reasonsMax: number;
  alternativeReason: number;
  strongestAlternativeWhy: number;
  strongestCounterargument: number;
  whyRecommendationStillWins: number;
  expectedNextPickPlan: number;
  firstSeedDeviationReason: number;
  opponentWhy: number;
  opponentsMax: number;
}

/**
 * The original contract: room to argue at length.
 *
 * Produced answers of 1,300-4,800 output tokens, which is a lot of prose for a
 * screen that shows a player and a few lines.
 */
const LONG_LIMITS: ContractLimits = {
  strategy: 800,
  reasonCode: 60,
  reasonDetail: 700,
  reasonsMax: 6,
  alternativeReason: 500,
  strongestAlternativeWhy: 500,
  strongestCounterargument: 800,
  whyRecommendationStillWins: 800,
  expectedNextPickPlan: 900,
  firstSeedDeviationReason: 800,
  opponentWhy: 400,
  opponentsMax: 6,
};

/**
 * The same contract, sized for what a screen actually renders.
 *
 * Nobody reads a six-paragraph justification mid-draft, and the audit needs the
 * claim rather than the essay. The counterargument fields keep generous room
 * relative to the rest: they measurably improved decision quality, and the one
 * thing not worth economising on is the model's argument against itself.
 */
const CONCISE_LIMITS: ContractLimits = {
  strategy: 200,
  reasonCode: 40,
  reasonDetail: 200,
  reasonsMax: 3,
  alternativeReason: 150,
  strongestAlternativeWhy: 200,
  strongestCounterargument: 300,
  whyRecommendationStillWins: 300,
  expectedNextPickPlan: 250,
  firstSeedDeviationReason: 300,
  opponentWhy: 120,
  opponentsMax: 3,
};

function buildRecommendationTool(limits: ContractLimits, concise: boolean) {
  /** Appended to the fields where brevity is the whole point of the variant. */
  const brief = (target: string) => (concise ? ` ${target}` : '');

  return {
    name: 'submit_recommendation',
    description:
      'Submit the draft recommendation for this selection. This is the only way to answer.' +
      (concise
        ? ' Answer briefly: this is rendered on a screen mid-draft, not read as an essay. ' +
          'Brevity applies to the WORDING, never to the reasoning - work through the state ' +
          'in full and then report the conclusion tersely.'
        : ''),
    input_schema: {
      type: 'object' as const,
      properties: {
        recommendedPlayerId: {
          type: 'string',
          description:
            "The id column value from the board table, copied exactly. Not the player's name.",
        },
        alternatives: {
          type: 'array',
          description:
            'The next two best selections, in order, if the primary were unavailable.',
          minItems: 2,
          maxItems: 2,
          items: {
            type: 'object',
            properties: {
              playerId: { type: 'string', description: 'Board table id, copied exactly.' },
              reason: {
                type: 'string',
                maxLength: limits.alternativeReason,
                description:
                  'Why he is the next best selection.' + brief('One short sentence.'),
              },
            },
            required: ['playerId', 'reason'],
            additionalProperties: false,
          },
        },
        confidence: {
          type: 'integer',
          minimum: 0,
          maximum: 100,
          description:
            'How confident you are that this is the best selection. Low when the top options are genuinely close.',
        },
        urgency: {
          type: 'string',
          enum: ['must_take_now', 'likely_to_return', 'neutral'],
          description:
            'How much the TIMING matters, separately from whether he is the right pick - ' +
            'recommendedPlayerId already says he is. must_take_now: waiting carries real risk ' +
            'or opportunity cost. likely_to_return: still the best pick, but he would reasonably ' +
            'likely survive to our next selection. neutral: urgency is not part of why he is the ' +
            'best pick, which is normally the case at our final selection. Weigh the survival and ' +
            'joint-availability figures as evidence, but do not read the answer off a threshold - ' +
            'a player at 80% can be must_take_now if losing him has no replacement, and one at 30% ' +
            'can be neutral if the pick is right regardless.',
        },
        strategy: {
          type: 'string',
          maxLength: limits.strategy,
          description:
            'The roster shape this pick serves, named concretely - e.g. "hero RB, now pivoting ' +
            'to fill the TE slot before the tier empties".' +
            brief('One short sentence, no preamble.'),
        },
        reasons: {
          type: 'array',
          minItems: 2,
          maxItems: limits.reasonsMax,
          description:
            'Structured reasons, each checkable against the supplied state. Name players, ' +
            'positions and numbers.' +
            brief(`At most ${limits.reasonsMax} - the ones the decision actually turned on.`),
          items: {
            type: 'object',
            properties: {
              code: {
                type: 'string',
                maxLength: limits.reasonCode,
                description:
                  'A short snake_case label, e.g. starter_need, tier_cliff, opportunity_cost, positional_scarcity, survives_to_next_turn, opponent_demand, first_seed_prior.',
              },
              detail: {
                type: 'string',
                maxLength: limits.reasonDetail,
                description: 'One concrete sentence.' + brief('Numbers, not narration.'),
              },
            },
            required: ['code', 'detail'],
            additionalProperties: false,
          },
        },
        strongestAlternativePlayerId: {
          type: 'string',
          description:
            'The single best selection other than your recommendation, as a board table id ' +
            'copied exactly. Never the same player as recommendedPlayerId.',
        },
        strongestAlternativeWhy: {
          type: 'string',
          maxLength: limits.strongestAlternativeWhy,
          description:
            'What makes him the strongest competing case.' + brief('One short sentence.'),
        },
        strongestCounterargument: {
          type: 'string',
          maxLength: limits.strongestCounterargument,
          description:
            'The single fact in the supplied state that most threatens your recommendation, ' +
            'stated as its advocate would state it and with the number quoted. For a ' +
            'must_take_now this is normally the best case for waiting - a joint availability ' +
            'figure showing the position survives, a deep tier, a high survival probability. ' +
            'Do not pick a weak objection you can easily dismiss.' +
            brief('Compress the wording, not the objection.'),
        },
        whyRecommendationStillWins: {
          type: 'string',
          maxLength: limits.whyRecommendationStillWins,
          description:
            'Answer that counterargument directly and specifically. Not a restatement of your ' +
            'reasons - engage with the number you just quoted and say why it does not change ' +
            'the decision. If it genuinely does, change your recommendation instead.' +
            brief('Compress the wording, not the answer.'),
        },
        firstSeedDeviationReason: {
          type: ['string', 'null'],
          maxLength: limits.firstSeedDeviationReason,
          description:
            "Required when the pick reaches meaningfully past First Seed's best available. " +
            'State the strategic reason and what it is worth. Null when following the board.' +
            brief('One short sentence when present.'),
        },
        expectedNextPickPlan: {
          type: 'string',
          maxLength: limits.expectedNextPickPlan,
          description:
            'What we expect to do at our next selection given this one, and which players we ' +
            'expect to still be available then.' + brief('One or two short sentences.'),
        },
        opponentsThatMatter: {
          type: 'array',
          minItems: 0,
          maxItems: limits.opponentsMax,
          description:
            'The specific teams whose selections between now and our next turn changed this ' +
            'decision.' + brief(`At most ${limits.opponentsMax}, the ones that mattered most.`),
          items: {
            type: 'object',
            properties: {
              rosterId: { type: 'integer' },
              why: {
                type: 'string',
                maxLength: limits.opponentWhy,
                description:
                  'What they need and what they are likely to take from us.' +
                  brief('A few words.'),
              },
            },
            required: ['rosterId', 'why'],
            additionalProperties: false,
          },
        },
      },
      required: [
        'recommendedPlayerId',
        'alternatives',
        'confidence',
        'urgency',
        'strategy',
        'reasons',
        'strongestAlternativePlayerId',
        'strongestAlternativeWhy',
        'strongestCounterargument',
        'whyRecommendationStillWins',
        'firstSeedDeviationReason',
        'expectedNextPickPlan',
        'opponentsThatMatter',
      ],
      additionalProperties: false,
    },
  };
}

export const SUBMIT_RECOMMENDATION_TOOL = buildRecommendationTool(LONG_LIMITS, false);
export const SUBMIT_RECOMMENDATION_TOOL_CONCISE = buildRecommendationTool(CONCISE_LIMITS, true);

export type RecommendationTool = typeof SUBMIT_RECOMMENDATION_TOOL;

/** Which variant of the contract to ask for. */
export function recommendationTool(concise: boolean): RecommendationTool {
  return concise ? SUBMIT_RECOMMENDATION_TOOL_CONCISE : SUBMIT_RECOMMENDATION_TOOL;
}

/** Exactly what the tool returns, before it is turned into `StrategistAdvice`. */
export interface StrategistResponse {
  recommendedPlayerId: string;
  alternatives: { playerId: string; reason: string }[];
  /** 0-100, as the model reports it. */
  confidence: number;
  /**
   * How much the timing matters, separately from whether he is the right pick.
   *
   * Replaces a DRAFT_NOW/WAIT flag that could not mean anything here:
   * `recommendedPlayerId` already says which player to select, so "wait" had no
   * operational reading - and the model duly returned DRAFT_NOW fourteen times
   * out of fourteen, including for players at 72-80% survival.
   */
  urgency: 'must_take_now' | 'likely_to_return' | 'neutral';
  strategy: string;
  reasons: { code: string; detail: string }[];
  /**
   * The best selection other than the recommendation, as two flat fields.
   *
   * It was one nested object, and that shape alone accounted for three of the
   * four malformed tool calls: the model emitted it as a JSON string, twice
   * truncated mid-value. No array-of-objects field has ever failed.
   */
  strongestAlternativePlayerId: string;
  strongestAlternativeWhy: string;
  /** The fact that most threatens the recommendation, stated at full strength. */
  strongestCounterargument: string;
  /** The direct answer to it. */
  whyRecommendationStillWins: string;
  firstSeedDeviationReason: string | null;
  expectedNextPickPlan: string;
  opponentsThatMatter: { rosterId: number; why: string }[];
}
