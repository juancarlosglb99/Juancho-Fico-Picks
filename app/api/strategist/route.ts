/**
 * The strategist, called from the server so the key never reaches a browser.
 *
 * The browser already holds the draft state, so it prepares the payload and
 * posts it here rather than making the server re-fetch Sleeper and First Seed
 * to rebuild something that already exists. What the server adds is the
 * credential, the retry, and validation of the reply against the contract.
 *
 * Advice is deliberately NOT built here. It has to be stamped with the board it
 * was asked about, and the caller is the one holding that brief - so the route
 * returns the validated response and the caller turns it into advice and runs
 * the guardrails against its own state.
 */
import {
  AnthropicStrategist,
  PRODUCTION_STRATEGIST,
  resolveStrategistModel,
} from '../../../packages/engine/strategist/anthropic/client';
import type { StrategistPromptContext } from '../../../packages/engine/strategist/prompt-context';
import type { DraftStateVersion } from '../../../packages/engine/strategist/types';

interface StrategistRequestBody {
  context: StrategistPromptContext;
  boardPlayerIds: string[];
  /** Echoed back untouched, so a reply can never be matched to another board. */
  state: DraftStateVersion;
}

/**
 * Whether a strategist is configured at all.
 *
 * The pre-draft check has to be able to say "AI available" or "not configured"
 * before a draft starts, and the browser cannot know. This answers only that -
 * a boolean and the model name, both of which are already visible in any advice
 * the route returns. The key itself never leaves the server.
 */
export function GET(): Response {
  return Response.json({
    configured: Boolean(process.env.ANTHROPIC_API_KEY),
    model: resolveStrategistModel(),
  });
}

export async function POST(request: Request): Promise<Response> {
  let body: StrategistRequestBody;
  try {
    body = (await request.json()) as StrategistRequestBody;
  } catch {
    return Response.json({ error: 'Malformed request body.' }, { status: 400 });
  }

  if (!body?.context || !Array.isArray(body.boardPlayerIds) || !body.state) {
    return Response.json(
      { error: 'A context, a board and a draft state are all required.' },
      { status: 400 },
    );
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    /*
     * Not an error the draft should notice. The deterministic recommendation is
     * already on screen; this simply means it stays there.
     */
    return Response.json({
      response: null,
      problems: [],
      state: body.state,
      model: resolveStrategistModel(),
      usage: null,
      attempts: 0,
      latencyMs: 0,
      error: 'The strategist is not configured.',
    });
  }

  const startedAt = Date.now();
  try {
    const strategist = new AnthropicStrategist(PRODUCTION_STRATEGIST);
    const result = await strategist.callWithContext(
      body.context,
      body.boardPlayerIds,
      request.signal,
    );

    return Response.json({
      response: result.response,
      problems: result.problems,
      // Echoed from the request, never from the model.
      state: body.state,
      model: result.model,
      usage: result.usage,
      attempts: result.attempts.length,
      latencyMs: result.latencyMs,
      error: result.error,
    });
  } catch (error) {
    return Response.json({
      response: null,
      problems: [],
      state: body.state,
      model: resolveStrategistModel(),
      usage: null,
      attempts: 0,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : 'The strategist call failed.',
    });
  }
}
