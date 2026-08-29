/**
 * Checking that the strategist answered the question we asked.
 *
 * A tool schema is a request, not a guarantee. The very first evaluation run
 * proved it: at pick 29 the model omitted `decision` entirely despite it being
 * listed as required, and nothing noticed - the field arrived as `undefined`,
 * flowed into the advice, and printed as "undefined" in the report. Nothing
 * downstream would have caught it either, because every consumer was written
 * assuming the schema had been honoured.
 *
 * So the response is validated before it becomes advice, and the rules here are
 * deliberately unforgiving:
 *
 *   - a missing field is never filled in, defaulted, or inferred
 *   - a malformed response is rejected WHOLE, never partially salvaged
 *   - every problem found is reported, not just the first
 *
 * Failing closed costs one recommendation. Silently coercing a missing field
 * produces a confident-looking answer that nobody can tell apart from a real
 * one, which is far worse.
 */
import {
  SUBMIT_RECOMMENDATION_TOOL,
  type RecommendationTool,
  type StrategistResponse,
} from './schema';

export type ResponseProblemCode =
  | 'not_an_object'
  | 'missing_field'
  | 'wrong_type'
  | 'out_of_range'
  | 'invalid_enum'
  | 'wrong_length'
  | 'empty_string'
  | 'too_long'
  | 'unknown_player';

export interface ResponseProblem {
  code: ResponseProblemCode;
  /** Dotted path into the response, e.g. `alternatives.1.playerId`. */
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; response: StrategistResponse; problems: [] }
  | { ok: false; response: null; problems: ResponseProblem[] };

/* -------------------------------------------------------- the contract itself */

/**
 * Every bound, read from the tool that was actually sent.
 *
 * Previously these were module constants taken from the one schema that
 * existed. With two variants of the contract that would validate a concise
 * answer against the long contract's limits - which is exactly the
 * two-contracts problem this file exists to prevent, one layer up.
 */
function boundsOf(tool: RecommendationTool) {
  const schema = tool.input_schema;
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  return {
    required: schema.required as (keyof StrategistResponse)[],
    alternativesMin: properties.alternatives.minItems as number,
    alternativesMax: properties.alternatives.maxItems as number,
    reasonsMin: properties.reasons.minItems as number,
    reasonsMax: properties.reasons.maxItems as number,
    opponentsMax: properties.opponentsThatMatter.maxItems as number,
    confidenceMin: properties.confidence.minimum as number,
    confidenceMax: properties.confidence.maximum as number,
    confidenceInteger: properties.confidence.type === 'integer',
    urgencies: properties.urgency.enum as string[],
    /** Ceilings by field path; absent means unbounded. */
    maxLength: {
      strategy: properties.strategy.maxLength as number | undefined,
      strongestAlternativeWhy: properties.strongestAlternativeWhy.maxLength as number | undefined,
      strongestCounterargument: properties.strongestCounterargument.maxLength as
        | number
        | undefined,
      whyRecommendationStillWins: properties.whyRecommendationStillWins.maxLength as
        | number
        | undefined,
      firstSeedDeviationReason: properties.firstSeedDeviationReason.maxLength as
        | number
        | undefined,
      expectedNextPickPlan: properties.expectedNextPickPlan.maxLength as number | undefined,
      alternativeReason: itemMax(properties.alternatives, 'reason'),
      reasonCode: itemMax(properties.reasons, 'code'),
      reasonDetail: itemMax(properties.reasons, 'detail'),
      opponentWhy: itemMax(properties.opponentsThatMatter, 'why'),
    },
  };
}

function itemMax(arrayProperty: Record<string, unknown>, field: string): number | undefined {
  const items = arrayProperty.items as Record<string, unknown> | undefined;
  const properties = items?.properties as Record<string, Record<string, unknown>> | undefined;
  return properties?.[field]?.maxLength as number | undefined;
}

export function validateStrategistResponse(
  raw: unknown,
  /** Ids from the board the model was shown. Anything else is invented. */
  boardPlayerIds: Iterable<string>,
  /** The contract that was actually sent. Defaults to the long variant. */
  tool: RecommendationTool = SUBMIT_RECOMMENDATION_TOOL,
): ValidationResult {
  const bounds = boundsOf(tool);
  const problems: ResponseProblem[] = [];
  const fail = (code: ResponseProblemCode, path: string, message: string) =>
    problems.push({ code, path, message });
  /** A ceiling the schema published, enforced exactly rather than approximately. */
  const checkLength = (value: unknown, path: string, limit: number | undefined) => {
    if (limit === undefined || typeof value !== 'string') return;
    if (value.length > limit) {
      fail('too_long', path, `Expected at most ${limit} characters, got ${value.length}.`);
    }
  };

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      response: null,
      problems: [
        { code: 'not_an_object', path: '', message: 'The tool response was not an object.' },
      ],
    };
  }
  const value = raw as Record<string, unknown>;
  const board = new Set(boardPlayerIds);

  /*
   * Presence first, and presence means PRESENT - `undefined` is missing however
   * it got there. `firstSeedDeviationReason` is the field this distinction was
   * written for: null is a real answer meaning "no deviation", while undefined
   * means the model never considered the question.
   */
  for (const field of bounds.required) {
    if (!(field in value) || value[field] === undefined) {
      fail('missing_field', field, `Required field "${field}" was not returned.`);
    }
  }

  /* ---------------------------------------------------------- the selection */

  const recommended = value.recommendedPlayerId;
  if ('recommendedPlayerId' in value) {
    if (typeof recommended !== 'string') {
      fail('wrong_type', 'recommendedPlayerId', 'Expected a player id string.');
    } else if (recommended.trim() === '') {
      fail('empty_string', 'recommendedPlayerId', 'The player id was empty.');
    } else if (!board.has(recommended)) {
      fail(
        'unknown_player',
        'recommendedPlayerId',
        `"${recommended}" is not an id on the board the strategist was shown.`,
      );
    }
  }

  /* -------------------------------------------------------- the alternatives */

  if ('alternatives' in value) {
    const alternatives = value.alternatives;
    if (!Array.isArray(alternatives)) {
      fail('wrong_type', 'alternatives', 'Expected an array of alternatives.');
    } else {
      if (alternatives.length < bounds.alternativesMin || alternatives.length > bounds.alternativesMax) {
        fail(
          'wrong_length',
          'alternatives',
          `Expected ${bounds.alternativesMin}-${bounds.alternativesMax} alternatives, got ${alternatives.length}.`,
        );
      }
      alternatives.forEach((entry, index) => {
        const path = `alternatives.${index}`;
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
          fail('wrong_type', path, 'Expected an object with playerId and reason.');
          return;
        }
        const alternative = entry as Record<string, unknown>;
        const playerId = alternative.playerId;
        if (typeof playerId !== 'string') {
          fail('wrong_type', `${path}.playerId`, 'Expected a player id string.');
        } else if (playerId.trim() === '') {
          fail('empty_string', `${path}.playerId`, 'The player id was empty.');
        } else if (!board.has(playerId)) {
          fail(
            'unknown_player',
            `${path}.playerId`,
            `"${playerId}" is not an id on the board the strategist was shown.`,
          );
        }
        requireText(alternative.reason, `${path}.reason`, fail);
        checkLength(alternative.reason, `${path}.reason`, bounds.maxLength.alternativeReason);
      });
    }
  }

  /* ------------------------------------------------------------- the verdict */

  if ('confidence' in value) {
    const confidence = value.confidence;
    if (typeof confidence !== 'number' || !Number.isFinite(confidence)) {
      fail('wrong_type', 'confidence', 'Expected a number.');
    } else if (confidence < bounds.confidenceMin || confidence > bounds.confidenceMax) {
      fail(
        'out_of_range',
        'confidence',
        `Expected ${bounds.confidenceMin}-${bounds.confidenceMax}, got ${confidence}.`,
      );
    } else if (bounds.confidenceInteger && !Number.isInteger(confidence)) {
      /*
       * The schema and the validator have to agree.
       *
       * This used to tolerate 78.5 against a schema that asked for an integer,
       * on the reasoning that rejecting a sound recommendation over half a
       * point costs more than it protects. That reasoning is fine; keeping two
       * different contracts is not, because the published one is what the model
       * is told and the enforced one is what actually happens. The schema says
       * integer, so integer is enforced - and nothing is lost, since a
       * subjective 0-100 judgement carries no information in its fraction.
       */
      fail('wrong_type', 'confidence', `Expected a whole number, got ${confidence}.`);
    }
  }

  if ('urgency' in value && !bounds.urgencies.includes(value.urgency as string)) {
    fail(
      'invalid_enum',
      'urgency',
      `Expected one of ${bounds.urgencies.join(' | ')}, got ${describe(value.urgency)}.`,
    );
  }

  requireText(value.strategy, 'strategy', fail, 'strategy' in value);
  checkLength(value.strategy, 'strategy', bounds.maxLength.strategy);
  requireText(value.expectedNextPickPlan, 'expectedNextPickPlan', fail, 'expectedNextPickPlan' in value);
  checkLength(value.expectedNextPickPlan, 'expectedNextPickPlan', bounds.maxLength.expectedNextPickPlan);

  /* ------------------------------------------------------------- the reasons */

  if ('reasons' in value) {
    const reasons = value.reasons;
    if (!Array.isArray(reasons)) {
      fail('wrong_type', 'reasons', 'Expected an array of reasons.');
    } else {
      if (reasons.length < bounds.reasonsMin || reasons.length > bounds.reasonsMax) {
        fail(
          'wrong_length',
          'reasons',
          `Expected ${bounds.reasonsMin}-${bounds.reasonsMax} reasons, got ${reasons.length}.`,
        );
      }
      reasons.forEach((entry, index) => {
        const path = `reasons.${index}`;
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
          fail('wrong_type', path, 'Expected an object with code and detail.');
          return;
        }
        const reason = entry as Record<string, unknown>;
        requireText(reason.code, `${path}.code`, fail);
        checkLength(reason.code, `${path}.code`, bounds.maxLength.reasonCode);
        requireText(reason.detail, `${path}.detail`, fail);
        checkLength(reason.detail, `${path}.detail`, bounds.maxLength.reasonDetail);
      });
    }
  }

  /* -------------------------------------------------- the counterargument */

  /*
   * These exist because the strategist once recommended a tight end while the
   * state in front of it said there was a 76% chance the tier survived to the
   * next turn - and never mentioned it. A model is not obliged to notice the
   * fact that most threatens its own answer unless it is asked to name it.
   */
  /*
   * Two flat fields rather than one nested object.
   *
   * The nested shape accounted for three of the four malformed tool calls in
   * production - emitted as a JSON string, twice truncated mid-value - while no
   * array-of-objects field has ever failed. Same meaning, a shape the model
   * serialises reliably.
   */
  if ('strongestAlternativePlayerId' in value) {
    const playerId = value.strongestAlternativePlayerId;
    if (typeof playerId !== 'string') {
      fail('wrong_type', 'strongestAlternativePlayerId', 'Expected a player id string.');
    } else if (playerId.trim() === '') {
      fail('empty_string', 'strongestAlternativePlayerId', 'The player id was empty.');
    } else if (!board.has(playerId)) {
      fail(
        'unknown_player',
        'strongestAlternativePlayerId',
        `"${playerId}" is not an id on the board the strategist was shown.`,
      );
    } else if (playerId === recommended) {
      // Naming your own pick as its own strongest rival answers nothing.
      fail(
        'wrong_type',
        'strongestAlternativePlayerId',
        'The strongest alternative cannot be the recommended player.',
      );
    }
  }
  requireText(
    value.strongestAlternativeWhy,
    'strongestAlternativeWhy',
    fail,
    'strongestAlternativeWhy' in value,
  );
  checkLength(
    value.strongestAlternativeWhy,
    'strongestAlternativeWhy',
    bounds.maxLength.strongestAlternativeWhy,
  );

  requireText(
    value.strongestCounterargument,
    'strongestCounterargument',
    fail,
    'strongestCounterargument' in value,
  );
  checkLength(
    value.strongestCounterargument,
    'strongestCounterargument',
    bounds.maxLength.strongestCounterargument,
  );
  requireText(
    value.whyRecommendationStillWins,
    'whyRecommendationStillWins',
    fail,
    'whyRecommendationStillWins' in value,
  );
  checkLength(
    value.whyRecommendationStillWins,
    'whyRecommendationStillWins',
    bounds.maxLength.whyRecommendationStillWins,
  );

  /*
   * Null is a valid answer here and undefined is not, which is why the presence
   * check above is separate from this type check.
   */
  if ('firstSeedDeviationReason' in value) {
    const reason = value.firstSeedDeviationReason;
    if (reason !== null && typeof reason !== 'string') {
      fail('wrong_type', 'firstSeedDeviationReason', 'Expected a string or null.');
    }
    checkLength(reason, 'firstSeedDeviationReason', bounds.maxLength.firstSeedDeviationReason);
  }

  /* ----------------------------------------------------------- the opponents */

  if ('opponentsThatMatter' in value) {
    const opponents = value.opponentsThatMatter;
    if (!Array.isArray(opponents)) {
      fail('wrong_type', 'opponentsThatMatter', 'Expected an array.');
    } else {
      if (opponents.length > bounds.opponentsMax) {
        fail(
          'wrong_length',
          'opponentsThatMatter',
          `Expected at most ${bounds.opponentsMax}, got ${opponents.length}.`,
        );
      }
      opponents.forEach((entry, index) => {
        const path = `opponentsThatMatter.${index}`;
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
          fail('wrong_type', path, 'Expected an object with rosterId and why.');
          return;
        }
        const opponent = entry as Record<string, unknown>;
        if (typeof opponent.rosterId !== 'number' || !Number.isInteger(opponent.rosterId)) {
          fail('wrong_type', `${path}.rosterId`, 'Expected an integer roster id.');
        }
        requireText(opponent.why, `${path}.why`, fail);
        checkLength(opponent.why, `${path}.why`, bounds.maxLength.opponentWhy);
      });
    }
  }

  if (problems.length > 0) return { ok: false, response: null, problems };
  return { ok: true, response: value as unknown as StrategistResponse, problems: [] };
}

/** One line summarising why a response was thrown away, for logs and audits. */
export function describeProblems(problems: ResponseProblem[]): string {
  return problems.map((problem) => `${problem.path || '<root>'}: ${problem.message}`).join(' ');
}

function requireText(
  value: unknown,
  path: string,
  fail: (code: ResponseProblemCode, path: string, message: string) => void,
  present = true,
): void {
  if (!present) return;
  if (typeof value !== 'string') {
    fail('wrong_type', path, 'Expected a string.');
    return;
  }
  if (value.trim() === '') fail('empty_string', path, 'Expected a non-empty string.');
}

function describe(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  return typeof value === 'string' ? `"${value}"` : String(value);
}
