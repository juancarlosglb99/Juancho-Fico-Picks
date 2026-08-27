/**
 * The shape the strategist must answer in.
 *
 * Structured output rather than prose, enforced by a forced tool call: a model
 * that can reply in sentences will eventually reply in sentences, and a parser
 * for those is a permanent source of silent failure. The schema also does real
 * work on the reasoning - asking for `expectedNextPickPlan` and
 * `opponentsThatMatter` by name forces the sequence and the room to actually be
 * considered rather than mentioned.
 */
export const SUBMIT_RECOMMENDATION_TOOL = {
  name: 'submit_recommendation',
  description:
    'Submit the draft recommendation for this selection. This is the only way to answer.',
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
              description: 'One sentence on why he is the next best selection.',
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
        description:
          'The roster shape this pick serves, named concretely - e.g. "hero RB, now pivoting to fill the TE slot before the tier empties". One or two sentences.',
      },
      reasons: {
        type: 'array',
        minItems: 2,
        maxItems: 6,
        description:
          'Short structured reasons, each checkable against the supplied state. Name players, positions and numbers.',
        items: {
          type: 'object',
          properties: {
            code: {
              type: 'string',
              description:
                'A short snake_case label, e.g. starter_need, tier_cliff, opportunity_cost, positional_scarcity, survives_to_next_turn, opponent_demand, first_seed_prior.',
            },
            detail: { type: 'string', description: 'One concrete sentence.' },
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
        description: 'One sentence on what makes him the strongest competing case.',
      },
      strongestCounterargument: {
        type: 'string',
        description:
          'The single fact in the supplied state that most threatens your recommendation, ' +
          'stated as its advocate would state it and with the number quoted. For a DRAFT_NOW ' +
          'this is normally the best case for waiting - a joint availability figure showing ' +
          'the position survives, a deep tier, a high survival probability. For a WAIT it is ' +
          'normally the best case for taking him now. Do not pick a weak objection you can ' +
          'easily dismiss. One or two sentences.',
      },
      whyRecommendationStillWins: {
        type: 'string',
        description:
          'Answer that counterargument directly and specifically. Not a restatement of your ' +
          'reasons - engage with the number you just quoted and say why it does not change ' +
          'the decision. If it genuinely does, change your recommendation instead. One or two ' +
          'sentences.',
      },
      firstSeedDeviationReason: {
        type: ['string', 'null'],
        description:
          "Required when the pick reaches meaningfully past First Seed's best available. State the strategic reason and what it is worth. Null when following the board.",
      },
      expectedNextPickPlan: {
        type: 'string',
        description:
          'What we expect to do at our next selection given this one, and which players we expect to still be available then.',
      },
      opponentsThatMatter: {
        type: 'array',
        minItems: 0,
        maxItems: 6,
        description:
          'The specific teams whose selections between now and our next turn changed this decision.',
        items: {
          type: 'object',
          properties: {
            rosterId: { type: 'integer' },
            why: {
              type: 'string',
              description: 'What they need and what they are likely to take from us.',
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
