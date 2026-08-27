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
      decision: {
        type: 'string',
        enum: ['DRAFT_NOW', 'WAIT'],
        description:
          'DRAFT_NOW when this player must be taken at this selection or lost. WAIT when he is likely to survive and the pick is being made for other reasons.',
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
      'decision',
      'strategy',
      'reasons',
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
  decision: 'DRAFT_NOW' | 'WAIT';
  strategy: string;
  reasons: { code: string; detail: string }[];
  firstSeedDeviationReason: string | null;
  expectedNextPickPlan: string;
  opponentsThatMatter: { rosterId: number; why: string }[];
}
