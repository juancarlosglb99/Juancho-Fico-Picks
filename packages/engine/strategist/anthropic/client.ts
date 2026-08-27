/**
 * The strategist, backed by Claude.
 *
 * SERVER ONLY. This module reads `ANTHROPIC_API_KEY` from the process
 * environment and must never be imported into anything that reaches a browser
 * bundle. The live path will call it from a server route for that reason; the
 * evaluation harness calls it from Node.
 *
 * The model is chosen by environment variable so it can be changed without
 * touching a line of recommendation code, and the id is recorded on every piece
 * of advice so an audit says which model produced it.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { DraftBrief, StrategistAdvice, StrategistClient } from '../types';
import { buildStrategistPromptContext, type PromptContextOptions } from '../prompt-context';
import { PLAYBOOK_VERSION, STRATEGIST_SYSTEM_PROMPT } from './playbook';
import {
  recommendationTool,
  type RecommendationTool,
  type StrategistResponse,
} from './schema';
import {
  describeProblems,
  validateStrategistResponse,
  type ResponseProblem,
} from './validate';

/** Changed with `JUANCHO_STRATEGIST_MODEL`; never hardcoded at a call site. */
export const DEFAULT_STRATEGIST_MODEL = 'claude-opus-5';

/**
 * The production contract: blind context, concise responses.
 *
 * Blind because a strategist shown the deterministic verdict ratifies it rather
 * than arbitrating - Sonnet agreed five times out of five with the answer in
 * front of it and twice out of five without. Concise because the screen shows a
 * player and a few lines, and the long form spent 1,800 output tokens per call
 * on prose nobody reads for the same recommendation four times in five.
 *
 * The long contract stays available as a diagnostic: when a recommendation
 * needs explaining, the fuller argument is worth paying for.
 */
export const PRODUCTION_STRATEGIST: AnthropicStrategistOptions = {
  promptContext: { blind: true },
  concise: true,
};
export const DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicStrategistOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  /** Extended thinking budget in tokens. Zero or undefined disables it. */
  thinkingBudget?: number;
  promptContext?: Partial<PromptContextOptions>;
  /**
   * Ask for the short form of the same contract.
   *
   * Identical fields, requirements and enums - only the room for prose differs.
   * The screen shows a player and a few lines, so a six-paragraph justification
   * is output tokens nobody reads.
   */
  concise?: boolean;
}

/** What one request to the model produced, before or after repair. */
export interface CallAttempt {
  /** Empty when the attempt satisfied the contract. */
  problems: ResponseProblem[];
  rawResponse: unknown;
  usage: { inputTokens: number; outputTokens: number } | null;
  latencyMs: number;
  error: string | null;
}

export interface StrategistCallResult {
  advice: StrategistAdvice | null;
  /** The validated tool input, kept verbatim for auditing. Null if it failed. */
  response: StrategistResponse | null;
  /**
   * The unvalidated tool input, kept even when validation rejected it.
   *
   * A response that fails is the only evidence of HOW it failed, so it is
   * preserved for the audit rather than discarded with the advice.
   */
  rawResponse: unknown;
  /** Everything wrong with the FINAL response. Empty when it was accepted. */
  problems: ResponseProblem[];
  /**
   * Every request made, in order. One entry normally, two after a repair.
   *
   * Kept in full because a repaired answer and a first-time answer are not the
   * same event: one says the model needed correcting, and how often that
   * happens is a property worth watching rather than smoothing over.
   */
  attempts: CallAttempt[];
  repairAttempted: boolean;
  /** The model's own reasoning, when extended thinking is on. */
  thinking: string | null;
  model: string;
  usage: { inputTokens: number; outputTokens: number } | null;
  latencyMs: number | null;
  error: string | null;
}

export function resolveStrategistModel(explicit?: string): string {
  return explicit ?? process.env.JUANCHO_STRATEGIST_MODEL ?? DEFAULT_STRATEGIST_MODEL;
}

/**
 * Extended thinking budget, in tokens. Zero is off, which is the default.
 *
 * Configurable rather than chosen, because the two modes are a real trade and
 * which one is better here has not been measured yet. With thinking off the
 * tool call can be FORCED, so a prose answer is structurally impossible. With
 * it on the model reasons at length first, but the API does not permit forced
 * tool use alongside it - the call has to be requested rather than compelled.
 * The structured fields carry the reasoning either way.
 */
export function resolveThinkingBudget(explicit?: number): number {
  if (explicit !== undefined) return explicit;
  const configured = Number(process.env.JUANCHO_STRATEGIST_THINKING ?? 0);
  return Number.isFinite(configured) && configured > 0 ? configured : 0;
}

/**
 * A `StrategistClient` that asks Claude.
 *
 * Everything it needs is the brief; the compression into a prompt payload
 * happens here rather than at the call site, so callers never have to know
 * which representation the model sees.
 */
export class AnthropicStrategist implements StrategistClient {
  readonly id: string;
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly thinkingBudget: number;
  /**
   * Public so a caller can key a cache on the payload this strategist will
   * actually send. Deriving it with default options instead produced identical
   * keys for blind and open runs, which silently served open-context answers to
   * a blind experiment.
   */
  readonly promptContext: Partial<PromptContextOptions>;
  /** True when the deterministic verdict is withheld from the payload. */
  readonly isBlind: boolean;
  /** The contract this strategist asks for. Part of what the cache keys on. */
  readonly tool: RecommendationTool;
  readonly isConcise: boolean;
  readonly isCompact: boolean;

  constructor(options: AnthropicStrategistOptions = {}) {
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY is not set. The strategist runs server-side only and needs it in the process environment.',
      );
    }
    this.model = resolveStrategistModel(options.model);
    this.thinkingBudget = resolveThinkingBudget(options.thinkingBudget);
    // The budget is spent out of max_tokens, so the ceiling has to clear it
    // with room left for the answer itself.
    this.maxTokens = Math.max(
      options.maxTokens ?? DEFAULT_MAX_TOKENS,
      this.thinkingBudget > 0 ? this.thinkingBudget + DEFAULT_MAX_TOKENS : 0,
    );
    this.promptContext = options.promptContext ?? {};
    this.isBlind = this.promptContext.blind === true;
    this.isConcise = options.concise === true;
    this.isCompact = this.promptContext.compact === true;
    this.tool = recommendationTool(this.isConcise);
    this.client = new Anthropic({ apiKey });
    this.id = `anthropic:${this.model}`;
  }

  async advise(brief: DraftBrief, signal?: AbortSignal): Promise<StrategistAdvice | null> {
    const result = await this.call(brief, signal);
    return result.advice;
  }

  /** The full call, including any repair attempt: usage, thinking, raw responses. */
  async call(brief: DraftBrief, signal?: AbortSignal): Promise<StrategistCallResult> {
    const context = buildStrategistPromptContext(brief, this.promptContext);
    const boardIds = brief.candidates.map((candidate) => candidate.playerId);
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: `Current draft state:\n\n${JSON.stringify(context)}` },
    ];

    const attempts: CallAttempt[] = [];
    let thinking: string | null = null;

    /*
     * One repair, and only one.
     *
     * Two malformed responses in eight calls, both dropping the same required
     * field, is a reliability property rather than a fluke - and a contract
     * violation is the one failure a model can reliably fix when it is simply
     * shown what it broke. What we must NOT do is fill the field in ourselves:
     * that manufactures an answer nobody can tell from a real one, which is the
     * failure the validator exists to prevent.
     *
     * A second failure means something is wrong beyond a slip, so it falls back
     * to the deterministic engine exactly as before.
     */
    for (let attempt = 0; attempt <= 1; attempt += 1) {
      const outcome = await this.request(messages, signal);
      thinking = outcome.thinking ?? thinking;

      if (outcome.transportError) {
        attempts.push({
          problems: [],
          rawResponse: null,
          usage: outcome.usage,
          latencyMs: outcome.latencyMs,
          error: outcome.transportError,
        });
        // A network or API failure is not something the model can repair.
        return assemble(attempts, null, null, thinking, this.model, outcome.transportError);
      }

      if (!outcome.toolUse) {
        attempts.push({
          problems: [],
          rawResponse: null,
          usage: outcome.usage,
          latencyMs: outcome.latencyMs,
          error: 'The strategist returned no recommendation.',
        });
        return assemble(
          attempts,
          null,
          null,
          thinking,
          this.model,
          'The strategist returned no recommendation.',
        );
      }

      const validation = validateStrategistResponse(outcome.toolUse.input, boardIds, this.tool);
      attempts.push({
        problems: validation.problems,
        rawResponse: outcome.toolUse.input,
        usage: outcome.usage,
        latencyMs: outcome.latencyMs,
        error: validation.ok
          ? null
          : `The strategist's response did not satisfy the contract. ${describeProblems(validation.problems)}`,
      });

      if (validation.ok) {
        return assemble(
          attempts,
          validation.response,
          toAdvice(validation.response, brief, this.model),
          thinking,
          this.model,
          null,
        );
      }

      if (attempt === 1) break;

      // Hand the invalid call back with the exact faults, and ask for the same
      // analysis in a valid envelope.
      messages.push(
        { role: 'assistant', content: outcome.content },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result' as const,
              tool_use_id: outcome.toolUse.id,
              is_error: true,
              content: repairInstruction(validation.problems),
            },
          ],
        },
      );
    }

    const last = attempts[attempts.length - 1];
    return assemble(attempts, null, null, thinking, this.model, last?.error ?? 'Unknown failure.');
  }

  /** One request/response round trip, with nothing interpreted yet. */
  private async request(
    messages: Anthropic.MessageParam[],
    signal?: AbortSignal,
  ): Promise<{
    toolUse: Anthropic.ToolUseBlock | null;
    content: Anthropic.ContentBlock[];
    thinking: string | null;
    usage: { inputTokens: number; outputTokens: number } | null;
    latencyMs: number;
    transportError: string | null;
  }> {
    const startedAt = Date.now();
    try {
      const message = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: this.maxTokens,
          system: STRATEGIST_SYSTEM_PROMPT,
          tools: [this.tool],
          /*
           * Forced when we can force it, so there is no path to a prose answer.
           * Extended thinking does not permit forced tool use, so with thinking
           * on the call is requested instead - and the playbook's closing line
           * exists precisely to hold that case.
           */
          tool_choice:
            this.thinkingBudget > 0
              ? { type: 'auto' as const }
              : { type: 'tool' as const, name: this.tool.name },
          ...(this.thinkingBudget > 0
            ? { thinking: { type: 'enabled' as const, budget_tokens: this.thinkingBudget } }
            : {}),
          messages,
        },
        signal ? { signal } : undefined,
      );
      const thinking = message.content
        .filter((block): block is Anthropic.ThinkingBlock => block.type === 'thinking')
        .map((block) => block.thinking)
        .join('\n')
        .trim();
      return {
        toolUse:
          message.content.find(
            (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
          ) ?? null,
        content: message.content,
        thinking: thinking || null,
        usage: usageOf(message),
        latencyMs: Date.now() - startedAt,
        transportError: null,
      };
    } catch (error) {
      return {
        toolUse: null,
        content: [],
        thinking: null,
        usage: null,
        latencyMs: Date.now() - startedAt,
        transportError: redactSecrets(error instanceof Error ? error.message : String(error)),
      };
    }
  }
}

/**
 * What the model is told when its answer did not satisfy the contract.
 *
 * Three things it has to convey: exactly what was wrong, that the ANALYSIS is
 * not what is being questioned, and that the fix is a complete payload rather
 * than a patch. Without the second, a model asked to try again tends to
 * reconsider the pick as well, which turns a formatting slip into a different
 * recommendation and makes the repair unauditable.
 */
export function repairInstruction(problems: ResponseProblem[]): string {
  const faults = problems
    .map((problem) => `  - ${problem.path || '<root>'}: ${problem.message}`)
    .join('\n');
  return [
    'Your submit_recommendation call was rejected because it did not match the required schema:',
    faults,
    '',
    'Your strategic analysis is not in question and should not change unless a listed problem',
    'genuinely requires it (for example, a player id that is not on the board).',
    '',
    'Call submit_recommendation again with the COMPLETE payload - every required field, not',
    'only the ones listed above. Keep the same recommendation, alternatives, reasons and',
    'confidence you had already decided on.',
  ].join('\n');
}

function assemble(
  attempts: CallAttempt[],
  response: StrategistResponse | null,
  advice: StrategistAdvice | null,
  thinking: string | null,
  model: string,
  error: string | null,
): StrategistCallResult {
  const last = attempts[attempts.length - 1];
  return {
    advice,
    response,
    rawResponse: last?.rawResponse ?? null,
    problems: last?.problems ?? [],
    attempts,
    repairAttempted: attempts.length > 1,
    thinking,
    model,
    // Totals: a repaired answer cost both requests, and reporting only the
    // successful one would understate what it took to get it.
    usage: attempts.reduce(
      (total, attempt) => ({
        inputTokens: total.inputTokens + (attempt.usage?.inputTokens ?? 0),
        outputTokens: total.outputTokens + (attempt.usage?.outputTokens ?? 0),
      }),
      { inputTokens: 0, outputTokens: 0 },
    ),
    latencyMs: attempts.reduce((total, attempt) => total + attempt.latencyMs, 0),
    error,
  };
}

/**
 * Turns a tool response into advice.
 *
 * The board state is stamped from the brief rather than trusted from the model:
 * what the strategist reasoned about is a fact about which brief it was given,
 * not something it should be able to assert.
 */
export function toAdvice(
  response: StrategistResponse,
  brief: DraftBrief,
  model: string,
): StrategistAdvice {
  const codes = response.reasons.map((reason) => reason.code);
  const reasoning = response.reasons.map((reason) => `${reason.code}: ${reason.detail}`).join(' ');

  return {
    state: brief.state,
    primary: {
      playerId: response.recommendedPlayerId,
      reasoning,
      reasonCodes: codes,
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

/** Identifies the exact strategist, so a cached answer is never reused across changes. */
export function strategistFingerprint(model: string): string {
  return `${model}/playbook-v${PLAYBOOK_VERSION}`;
}

function usageOf(message: Anthropic.Message): { inputTokens: number; outputTokens: number } {
  return { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens };
}

/**
 * Strips anything key-shaped out of text that is about to be printed or stored.
 *
 * An SDK error can carry the request that produced it, and a cached call is a
 * file on disk that gets read back and logged. Neither should ever be able to
 * carry the credential, so the boundary scrubs rather than trusting that it
 * never happens.
 */
export function redactSecrets(text: string): string {
  return text.replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-***');
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
