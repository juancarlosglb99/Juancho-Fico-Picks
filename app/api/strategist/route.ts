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
 *
 * WHAT STOPS A RUNAWAY BILL. Everything: the kill switch, the deployment's
 * daily and monthly ceilings, the per-draft call, repair and spend caps, the
 * one-request-at-a-time lease and the per-selection dedupe. All of them are
 * decided in `resolveAiAccess` before this function has a client, and none of
 * them can be influenced by the request body beyond which pick it names. A
 * client that removed every guardrail of its own would still hit all of them.
 *
 * The slot taken by a granted request is given back in a `finally`, on every
 * path out of here, because a lease released only on success would lock a user
 * out of their own draft for two minutes every time the network hiccuped.
 */
import {
  AnthropicStrategist,
  PRODUCTION_STRATEGIST,
  resolveStrategistModel,
} from '../../../packages/engine/strategist/anthropic/client';
import { estimateCost } from '../../../packages/engine/strategist/anthropic/pricing';
import type { StrategistPromptContext } from '../../../packages/engine/strategist/prompt-context';
import type { DraftStateVersion } from '../../../packages/engine/strategist/types';
import {
  recordAttempts,
  recordCall,
  releaseAiRequest,
  resolveAiAccess,
} from '../../../packages/accounts/service';
import {
  estimateContextTokens,
  killSwitchEngaged,
} from '../../../packages/accounts/ai-limits';
import { readAiControl } from '../../../packages/accounts/repository';
import { databaseConfigured } from '../../../packages/db/client';

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
export async function GET(): Promise<Response> {
  const configured = Boolean(process.env.ANTHROPIC_API_KEY);
  /*
   * The switch is read here as well as in the authorisation path, so a draft
   * room opened while AI is off says so up front rather than offering a feature
   * that will decline every request. A database that will not answer is treated
   * as "not switched off", because the authorisation path is the one that
   * actually gates spending and it fails closed on its own.
   */
  const control = databaseConfigured()
    ? await readAiControl().catch(() => ({ enabled: true, disabledReason: null }))
    : { enabled: true, disabledReason: null };
  const enabled = !killSwitchEngaged() && control.enabled;

  return Response.json({
    configured,
    enabled,
    available: configured && enabled,
    disabledReason: enabled ? null : (control.disabledReason ?? null),
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
  const model = resolveStrategistModel();

  /*
   * Which pick this is, taken from the state the client already echoes rather
   * than from a field of its own. One less thing to send, and one less place
   * for the key that dedupes a paid call to disagree with the board it names.
   */
  const selectionKey = String(body.state.currentOverallPick ?? 'unknown');

  let decision;
  try {
    decision = await resolveAiAccess({
      request,
      sleeperDraftId: body.state.draftId,
      selectionKey,
      model,
      // Measured from the payload we are about to send, so the spend cap
      // reserves what THIS call could cost rather than what a typical one does.
      promptTokens: estimateContextTokens(body.context),
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
     *
     * Every ceiling in `ai-limits.ts` arrives here, so hitting a spend cap and
     * being on the wrong plan degrade identically: no call is made, and the
     * draft carries on unchanged.
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
  /*
   * From here the request holds one of this user's slots, so every exit runs
   * the release. The outcome is recorded with it: only a call that actually
   * produced a response marks the selection answered, which is what stops a
   * failed call from permanently consuming the pick it failed on.
   */
  let outcome: 'answered' | 'failed' | 'abandoned' = 'failed';
  try {
    const strategist = new AnthropicStrategist(PRODUCTION_STRATEGIST);
    const result = await strategist.callWithContext(
      body.context,
      body.boardPlayerIds,
      request.signal,
    );
    outcome = result.response !== null ? 'answered' : 'failed';

    /*
     * Recorded with the SAME `estimateCost` the client's ledger uses, so the
     * database and the screen cannot report different money for the same call.
     */
    /*
     * The audit row, before anything else. It is what lets a failure be
     * diagnosed without paying to reproduce it, and it is best-effort - a
     * broken audit must not break a draft.
     */
    await recordAttempts({
      decision,
      boardFingerprint: body.state.boardFingerprint ?? null,
      selectionKey,
      model: result.model,
      attempts: result.attempts,
    }).catch(() => undefined);

    // Logged too, so an operator with a terminal sees it without SQL.
    if (result.response === null) {
      console.error(
        '[strategist] no usable answer',
        JSON.stringify({
          draft: body.state.draftId,
          pick: selectionKey,
          attempts: result.attempts.map((attempt) => ({
            stop: attempt.diagnostics.stopReason,
            blocks: attempt.diagnostics.contentBlockTypes,
            toolUse: attempt.diagnostics.hadToolUse,
            toolKeys: attempt.diagnostics.toolInputKeyCount,
            status: attempt.diagnostics.providerErrorStatus,
            type: attempt.diagnostics.providerErrorType,
            out: attempt.usage?.outputTokens ?? 0,
          })),
        }),
      );
    }

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
    // An aborted request spent nothing worth attributing to the pick, so it is
    // recorded as abandoned and the selection stays askable.
    outcome = request.signal.aborted ? 'abandoned' : 'failed';
    const accountUsage = await recordCall({
      decision,
      model,
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
  } finally {
    await releaseAiRequest(decision, outcome);
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
