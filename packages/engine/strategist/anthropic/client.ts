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
import { SUBMIT_RECOMMENDATION_TOOL, type StrategistResponse } from './schema';

/** Changed with `JUANCHO_STRATEGIST_MODEL`; never hardcoded at a call site. */
export const DEFAULT_STRATEGIST_MODEL = 'claude-opus-5';
export const DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicStrategistOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  /** Extended thinking budget in tokens. Zero or undefined disables it. */
  thinkingBudget?: number;
  promptContext?: Partial<PromptContextOptions>;
}

export interface StrategistCallResult {
  advice: StrategistAdvice | null;
  /** The raw tool input, kept verbatim for auditing. */
  response: StrategistResponse | null;
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
  private readonly promptContext: Partial<PromptContextOptions>;

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
    this.client = new Anthropic({ apiKey });
    this.id = `anthropic:${this.model}`;
  }

  async advise(brief: DraftBrief, signal?: AbortSignal): Promise<StrategistAdvice | null> {
    const result = await this.call(brief, signal);
    return result.advice;
  }

  /** The full call, for the evaluation harness: usage, thinking, raw response. */
  async call(brief: DraftBrief, signal?: AbortSignal): Promise<StrategistCallResult> {
    const context = buildStrategistPromptContext(brief, this.promptContext);
    const startedAt = Date.now();

    try {
      const message = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: this.maxTokens,
          system: STRATEGIST_SYSTEM_PROMPT,
          tools: [SUBMIT_RECOMMENDATION_TOOL],
          /*
           * Forced when we can force it, so there is no path to a prose answer.
           * Extended thinking does not permit forced tool use, so with thinking
           * on the call is requested instead - and the playbook's closing line
           * exists precisely to hold that case.
           */
          tool_choice:
            this.thinkingBudget > 0
              ? { type: 'auto' as const }
              : { type: 'tool' as const, name: SUBMIT_RECOMMENDATION_TOOL.name },
          ...(this.thinkingBudget > 0
            ? { thinking: { type: 'enabled' as const, budget_tokens: this.thinkingBudget } }
            : {}),
          messages: [
            {
              role: 'user',
              content: `Current draft state:\n\n${JSON.stringify(context)}`,
            },
          ],
        },
        signal ? { signal } : undefined,
      );

      const latencyMs = Date.now() - startedAt;
      const toolUse = message.content.find(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );
      const thinking = message.content
        .filter((block): block is Anthropic.ThinkingBlock => block.type === 'thinking')
        .map((block) => block.thinking)
        .join('\n')
        .trim();

      if (!toolUse) {
        return {
          advice: null,
          response: null,
          thinking: thinking || null,
          model: this.model,
          usage: usageOf(message),
          latencyMs,
          error: 'The strategist returned no recommendation.',
        };
      }

      const response = toolUse.input as StrategistResponse;
      return {
        advice: toAdvice(response, brief, this.model),
        response,
        thinking: thinking || null,
        model: this.model,
        usage: usageOf(message),
        latencyMs,
        error: null,
      };
    } catch (error) {
      return {
        advice: null,
        response: null,
        thinking: null,
        model: this.model,
        usage: null,
        latencyMs: Date.now() - startedAt,
        error: redactSecrets(error instanceof Error ? error.message : String(error)),
      };
    }
  }
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
    decision: response.decision,
    strategy: response.strategy,
    firstSeedDeviationReason: response.firstSeedDeviationReason,
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
