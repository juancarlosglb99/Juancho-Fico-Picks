/**
 * The strategist, called from the server so the key never reaches a browser.
 *
 * The browser already holds the draft state, so it prepares the payload and
 * posts it here rather than making the server re-fetch Sleeper and First Seed
 * to rebuild something that already exists. What the server adds is the
 * credential, the retry, validation of the reply against the contract - and, as
 * of user accounts, the authority to spend money at all.
 *
 * THE ORDER MATTERS. Entitlement is resolved, and the credit is spent, BEFORE
 * Anthropic is called. Doing it afterwards would mean a user with no credits
 * could still cost us a request by ignoring the answer, and a crash between the
 * call and the write would give away an answer for nothing.
 *
 * Nothing about the caller is taken from the request body. The plan comes from
 * a row in our database keyed by a signed session cookie; the draft session is
 * looked up BY that user id, so a request naming somebody else's draft creates
 * an empty session of its own rather than reading theirs.
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
import { estimateCost } from '../../../packages/engine/strategist/anthropic/pricing';
import type { StrategistPromptContext } from '../../../packages/engine/strategist/prompt-context';
import type { DraftStateVersion } from '../../../packages/engine/strategist/types';
import { recordCall, resolveAiAccess } from '../../../packages/accounts/service';

interface StrategistRequestBody {
  context: StrategistPromptContext;
  boardPlayerIds: string[];
  /** Echoed back untouched, so a reply can never be matched to another board. */
  state: DraftStateVersion;
  /** Session metadata only. Nothing here can affect authorisation. */
  leagueId?: string | null;
  isMock?: boolean;
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

  if (!body?.context || !Array.isArray(body.boardPlayerIds) || !body.state?.draftId) {
    return Response.json(
      { error: 'A context, a board and a draft state are all required.' },
      { status: 400 },
    );
  }

  const strategistConfigured = Boolean(process.env.ANTHROPIC_API_KEY);

  let decision;
  try {
    decision = await resolveAiAccess({
      request,
      sleeperDraftId: body.state.draftId,
      leagueId: body.leagueId ?? null,
      isMock: Boolean(body.isMock),
      strategistConfigured,
    });
  } catch (error) {
    // A database that is down must not take the draft down with it. The
    // deterministic recommendation is already on screen; this keeps it there.
    return Response.json(
      {
        ...emptyResult(body.state),
        error: 'Account lookup failed, so the strategist was not called.',
        detail: error instanceof Error ? error.message : undefined,
      },
      { status: 200 },
    );
  }

  if (!decision.allowed) {
    /*
     * Not an error the draft should notice. The deterministic recommendation is
     * already on screen; this means it stays there, with one quiet line saying
     * why. 200 rather than 402/403 on purpose: the client's failure path is
     * "carry on without advice", and an HTTP error would make a normal, expected
     * plan boundary look like a broken request.
     */
    return Response.json({
      ...emptyResult(body.state),
      error: decision.message,
      refusal: decision.reason,
      plan: decision.plan,
      creditsRemaining: decision.creditsRemaining,
      accountUsage: decision.usage,
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

    /*
     * Recorded with the SAME `estimateCost` the client's ledger uses, so the
     * database and the screen cannot report different money for the same call.
     */
    const cost = result.usage ? estimateCost(result.model, result.usage) : 0;
    const accountUsage = await recordCall({
      decision,
      model: result.model,
      attempts: result.attempts.length,
      usage: result.usage,
      estimatedCostUsd: cost,
      succeeded: result.response !== null,
    }).catch(() => null);

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
      plan: decision.plan,
      creditsRemaining: decision.creditsRemaining,
      accountUsage,
    });
  } catch (error) {
    const accountUsage = await recordCall({
      decision,
      model: resolveStrategistModel(),
      attempts: 1,
      usage: null,
      estimatedCostUsd: 0,
      succeeded: false,
    }).catch(() => null);

    return Response.json({
      ...emptyResult(body.state),
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : 'The strategist call failed.',
      plan: decision.plan,
      creditsRemaining: decision.creditsRemaining,
      accountUsage,
    });
  }
}

/** A well-formed "nothing came back", which the client already knows how to use. */
function emptyResult(state: DraftStateVersion) {
  return {
    response: null,
    problems: [],
    state,
    model: resolveStrategistModel(),
    usage: null,
    attempts: 0,
    latencyMs: 0,
  };
}
