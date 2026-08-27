/**
 * The strategist during a live draft, exercised entirely with fakes.
 *
 * The behaviours that matter here are all about what happens when things go
 * wrong, because the one thing a draft cannot tolerate is a broken screen while
 * a clock runs. Every path below ends with a recommendation showing.
 *
 * The sharpest of them is staleness. A reply about pick 47 arriving after the
 * room reached 49 looks exactly like fresh advice while describing players who
 * are already gone, and nothing downstream could tell the difference - so it is
 * checked against the board it was asked about and discarded whole.
 *
 * No network. The transport is a fake, and a test that made a real call would
 * be spending money to prove something a fake proves better.
 */
import { describe, expect, it, vi } from 'vitest';
import { generateDraftRecommendations } from '../../packages/engine/draft/recommendations';
import { buildDraftBrief } from '../../packages/engine/strategist/brief';
import {
  DEFAULT_CALL_POLICY,
  LiveStrategist,
  UsageLedger,
  shouldRequest,
  type StrategistCallPolicy,
  type StrategistTransport,
  type StrategistTransportResult,
} from '../../packages/engine/strategist/live';
import type { StrategistResponse } from '../../packages/engine/strategist/anthropic/schema';
import type { DraftBrief } from '../../packages/engine/strategist/types';
import type { SleeperDraftPick } from '../../packages/sleeper/types';
import {
  makeContext,
  makeDraft,
  makeLeague,
  makePlayerPool,
  makeProjections,
  makeRoomRankings,
  makeRosters,
} from './fixtures';

const TEAMS = 12;
const players = makePlayerPool(64);
const projections = makeProjections(players);
const roomRankings = makeRoomRankings(projections);

function briefAfter(pickCount: number): DraftBrief {
  const ranked = [...projections].sort((a, b) => b.projection - a.projection);
  const picks: SleeperDraftPick[] = Array.from({ length: pickCount }, (_, index) => {
    const overall = index + 1;
    const round = Math.ceil(overall / TEAMS);
    const pickInRound = ((overall - 1) % TEAMS) + 1;
    const slot = round % 2 === 0 ? TEAMS + 1 - pickInRound : pickInRound;
    return {
      player_id: players.byId.get(ranked[index].playerId)!.externalIds.sleeper!,
      picked_by: `user-${slot}`,
      roster_id: String(slot),
      round,
      draft_slot: slot,
      pick_no: overall,
      metadata: {},
    };
  });
  const league = makeLeague({ teams: TEAMS });
  const draft = makeDraft({ teams: TEAMS });
  const rosters = makeRosters(TEAMS);
  const { context, board } = makeContext({ league, draft, picks, rosters, players });
  const result = generateDraftRecommendations({
    context,
    picks,
    rosters,
    board,
    players,
    projections,
    roomRankings,
  });
  return buildDraftBrief({
    context,
    board,
    picks,
    rosters,
    players,
    result,
    draftId: 'draft-1',
    isMock: true,
  })!;
}

/** A board where it is our turn, so the policy always calls. */
function ourTurn(): DraftBrief {
  for (let picks = 0; picks < 40; picks += 1) {
    const brief = briefAfter(picks);
    if (brief.draft.isOurSelection) return brief;
  }
  throw new Error('no selection of ours in the first forty picks');
}

function responseFor(brief: DraftBrief, playerId: string): StrategistResponse {
  const others = brief.candidates.filter((candidate) => candidate.playerId !== playerId);
  return {
    recommendedPlayerId: playerId,
    alternatives: [
      { playerId: others[0].playerId, reason: 'Second best.' },
      { playerId: others[1].playerId, reason: 'Third best.' },
    ],
    confidence: 74,
    urgency: 'must_take_now',
    strategy: 'Fill the last startable slot before the tier breaks.',
    reasons: [
      { code: 'tier_cliff', detail: 'Two left in the tier.' },
      { code: 'starter_need', detail: 'The slot is empty.' },
    ],
    strongestAlternativePlayerId: others[0].playerId,
    strongestAlternativeWhy: "First Seed's best available.",
    strongestCounterargument: 'He is 72% to survive to our next turn.',
    whyRecommendationStillWins: 'The 28% failure case has no replacement.',
    firstSeedDeviationReason: null,
    expectedNextPickPlan: 'Take the better remaining back next turn.',
    opponentsThatMatter: [{ rosterId: 4, why: 'They need the same position.' }],
  };
}

function result(
  brief: DraftBrief,
  overrides: Partial<StrategistTransportResult> = {},
): StrategistTransportResult {
  return {
    response: responseFor(brief, brief.deterministic.recommended!.playerId),
    problems: [],
    state: brief.state,
    model: 'claude-opus-5',
    usage: {
      inputTokens: 8500,
      cacheWriteTokens: 0,
      cacheReadTokens: 5337,
      outputTokens: 1200,
    },
    attempts: 1,
    latencyMs: 19000,
    error: null,
    ...overrides,
  };
}

/** Records every call so a test can assert how many were actually made. */
function fakeTransport(replies: (StrategistTransportResult | Error)[]) {
  const calls: { state: string }[] = [];
  let index = 0;
  const transport: StrategistTransport = {
    advise: async (input) => {
      calls.push({ state: input.state.boardFingerprint });
      const reply = replies[Math.min(index, replies.length - 1)];
      index += 1;
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  return { transport, calls };
}

/* ------------------------------------------------------------- call policy */

describe('when the strategist is worth calling', () => {
  it('does not call on every pick of a long draft', () => {
    const policy = DEFAULT_CALL_POLICY;
    // A fifteen-round draft is a hundred and fifty selections; the strategist
    // has nothing to say about most of them.
    const far = briefAfter(1);
    if (!far.draft.isOurSelection && (far.draft.picksUntilOurNextSelection ?? 99) > 3) {
      expect(shouldRequest(far, policy)).toBe(false);
    }
  });

  it('always calls when we are on the clock', () => {
    expect(shouldRequest(ourTurn(), DEFAULT_CALL_POLICY)).toBe(true);
  });

  it('starts analysing as our turn approaches', () => {
    const policy: StrategistCallPolicy = { ...DEFAULT_CALL_POLICY, analyzeWithin: 3 };
    for (let picks = 0; picks < 40; picks += 1) {
      const brief = briefAfter(picks);
      const until = brief.draft.picksUntilOurNextSelection;
      if (brief.draft.isOurSelection || until === null) continue;
      expect(shouldRequest(brief, policy)).toBe(until <= 3);
    }
  });

  it('can be switched off entirely, for a cap or a kill switch', () => {
    expect(shouldRequest(ourTurn(), { ...DEFAULT_CALL_POLICY, enabled: false })).toBe(false);
  });
});

/* ------------------------------------------------------------- happy paths */

describe('advice that arrives in time', () => {
  it('shows the deterministic pick as confirmed when the strategist agrees', async () => {
    const brief = ourTurn();
    const { transport, calls } = fakeTransport([result(brief)]);
    const live = new LiveStrategist(transport);

    await live.update(brief);
    const state = live.current();

    expect(calls).toHaveLength(1);
    expect(state.phase).toBe('ready');
    expect(state.decision!.outcome).toBe('ai_confirmed');
    expect(state.decision!.final).toMatchObject({
      playerId: brief.deterministic.recommended!.playerId,
      source: 'strategist',
    });
  });

  it('replaces the displayed pick when the strategist overrides', async () => {
    const brief = ourTurn();
    const other = brief.candidates.find(
      (candidate) => candidate.playerId !== brief.deterministic.recommended!.playerId,
    )!;
    const { transport } = fakeTransport([
      result(brief, { response: responseFor(brief, other.playerId) }),
    ]);
    const live = new LiveStrategist(transport);

    await live.update(brief);
    expect(live.current().decision!.outcome).toBe('ai_override');
    expect(live.current().decision!.final).toMatchObject({
      playerId: other.playerId,
      source: 'strategist',
    });
  });

  it('announces that it is analysing before the answer lands', async () => {
    const brief = ourTurn();
    let release: (value: StrategistTransportResult) => void;
    const pending = new Promise<StrategistTransportResult>((resolve) => {
      release = resolve;
    });
    const transport: StrategistTransport = { advise: () => pending };
    const live = new LiveStrategist(transport);

    const seen: string[] = [];
    live.subscribe((state) => seen.push(state.phase));

    const inFlight = live.update(brief);
    expect(live.current().phase).toBe('analyzing');
    release!(result(brief));
    await inFlight;

    expect(seen).toContain('analyzing');
    expect(live.current().phase).toBe('ready');
  });
});

/* ---------------------------------------------------------------- staleness */

describe('advice about a board that has moved', () => {
  it('never renders a reply about an earlier pick', async () => {
    const older = ourTurn();
    const newer = briefAfter(older.state.picksMade + 2);

    // The transport answers about the OLD board while we now hold a newer one.
    const { transport } = fakeTransport([result(older)]);
    const live = new LiveStrategist(transport, {
      ...DEFAULT_CALL_POLICY,
      analyzeWithin: 99,
    });

    await live.update(newer);
    const state = live.current();

    expect(state.phase).toBe('fallback');
    expect(state.decision).toBeNull();
    expect(state.reason).toContain('different board');
  });

  it('discards a reply that names another draft entirely', async () => {
    const brief = ourTurn();
    const { transport } = fakeTransport([
      result(brief, { state: { ...brief.state, draftId: 'someone-elses-draft' } }),
    ]);
    const live = new LiveStrategist(transport);

    await live.update(brief);
    expect(live.current().phase).toBe('fallback');
    expect(live.current().reason).toContain('different_draft');
  });

  it('aborts a request in flight when the room picks again', async () => {
    const first = ourTurn();
    const second = briefAfter(first.state.picksMade + 1);

    const aborted = vi.fn();
    let call = 0;
    const transport: StrategistTransport = {
      advise: (input) => {
        call += 1;
        // The first request hangs until it is abandoned; the second answers
        // normally, which is what the room picking again actually looks like.
        if (call === 1) {
          return new Promise((_resolve, reject) => {
            input.signal?.addEventListener('abort', () => {
              aborted();
              reject(new Error('aborted'));
            });
          });
        }
        return Promise.resolve(result(second));
      },
    };
    const live = new LiveStrategist(transport, { ...DEFAULT_CALL_POLICY, analyzeWithin: 99 });

    const inFlight = live.update(first);
    await live.update(second);
    await inFlight.catch(() => undefined);

    expect(aborted).toHaveBeenCalled();
    // The abandoned request never surfaces: the screen shows the answer about
    // the board actually in front of us.
    expect(call).toBe(2);
    expect(live.current().fingerprint).toBe(second.state.boardFingerprint);
    expect(live.current().phase).toBe('ready');
  });

  it('clears stale advice from the screen the moment the board changes', async () => {
    const first = ourTurn();
    const { transport } = fakeTransport([result(first)]);
    const live = new LiveStrategist(transport, { ...DEFAULT_CALL_POLICY, analyzeWithin: 99 });

    await live.update(first);
    expect(live.current().phase).toBe('ready');

    // A pick lands. Whatever is on screen describes a board that no longer
    // exists, so it goes immediately - not when the next answer arrives.
    const second = briefAfter(first.state.picksMade + 1);
    const settled = live.update(second);
    expect(live.current().decision).toBeNull();
    await settled;
  });
});

/* ------------------------------------------------------------- every failure */

describe('when the strategist fails', () => {
  it('keeps the deterministic pick when a repair succeeds', async () => {
    const brief = ourTurn();
    // Two attempts, second one good: the answer stands, and the repair is
    // recorded rather than hidden.
    const { transport } = fakeTransport([result(brief, { attempts: 2 })]);
    const live = new LiveStrategist(transport);

    await live.update(brief);
    expect(live.current().phase).toBe('ready');
    expect(live.current().decision!.audit.repair).toMatchObject({ attempted: true, attempts: 2 });
    expect(live.current().usage!.repairCalls).toBe(1);
  });

  it('falls back when the response is still malformed after repair', async () => {
    const brief = ourTurn();
    const { transport } = fakeTransport([
      result(brief, {
        response: null,
        attempts: 2,
        problems: [{ code: 'missing_field', path: 'urgency', message: 'absent' }],
        error: 'The response did not satisfy the contract.',
      }),
    ]);
    const live = new LiveStrategist(transport);

    await live.update(brief);
    expect(live.current().phase).toBe('fallback');
    expect(live.current().decision!.outcome).toBe('ai_malformed');
    expect(live.current().decision!.final).toMatchObject({
      playerId: brief.deterministic.recommended!.playerId,
      source: 'deterministic',
    });
  });

  it('falls back when the strategist names a player who is gone', async () => {
    const brief = ourTurn();
    const drafted = brief.room.allDraftedPlayerIds[0];
    const { transport } = fakeTransport([
      result(brief, { response: responseFor(brief, drafted) }),
    ]);
    const live = new LiveStrategist(transport);

    await live.update(brief);
    expect(live.current().decision!.outcome).toBe('ai_rejected');
    expect(live.current().decision!.final!.source).toBe('deterministic');
  });

  it('survives an outage without breaking the screen', async () => {
    const brief = ourTurn();
    const { transport } = fakeTransport([new Error('529 overloaded')]);
    const live = new LiveStrategist(transport);

    await live.update(brief);
    const state = live.current();

    expect(state.phase).toBe('fallback');
    expect(state.reason).toContain('529');
    // No decision object at all, so the panel simply keeps showing Juancho.
    expect(state.decision).toBeNull();
  });

  it('reports an unconfigured strategist as a quiet fallback, not an error', async () => {
    const brief = ourTurn();
    const { transport } = fakeTransport([
      result(brief, { response: null, attempts: 0, error: 'The strategist is not configured.' }),
    ]);
    const live = new LiveStrategist(transport);

    await live.update(brief);
    expect(live.current().phase).toBe('fallback');
    expect(live.current().decision!.final!.source).toBe('deterministic');
  });
});

/* --------------------------------------------------------------- not paying */

describe('never paying twice for the same board', () => {
  it('ignores a poll where nothing changed', async () => {
    const brief = ourTurn();
    const { transport, calls } = fakeTransport([result(brief)]);
    const live = new LiveStrategist(transport);

    // Sleeper polls every 800ms; almost every poll changes nothing.
    await live.update(brief);
    await live.update(brief);
    await live.update(brief);

    expect(calls).toHaveLength(1);
    expect(live.usage('draft-1')!.calls).toBe(1);
  });

  it('does not call at all while our turn is far away', async () => {
    const { transport, calls } = fakeTransport([]);
    const live = new LiveStrategist(transport, { ...DEFAULT_CALL_POLICY, analyzeWithin: 0 });

    for (let picks = 1; picks <= 6; picks += 1) {
      const brief = briefAfter(picks);
      if (brief.draft.isOurSelection) continue;
      await live.update(brief);
    }
    expect(calls).toEqual([]);
  });

  it('asks again once the board genuinely moves', async () => {
    const first = ourTurn();
    const second = briefAfter(first.state.picksMade + 1);
    const { transport, calls } = fakeTransport([result(first), result(second)]);
    const live = new LiveStrategist(transport, { ...DEFAULT_CALL_POLICY, analyzeWithin: 99 });

    await live.update(first);
    await live.update(second);

    expect(calls).toHaveLength(2);
    expect(calls[0].state).not.toBe(calls[1].state);
  });
});

/* -------------------------------------------------------------- accounting */

describe('what it has cost', () => {
  it('tracks calls, tokens, repairs and an estimate, per draft', async () => {
    const brief = ourTurn();
    const { transport } = fakeTransport([result(brief, { attempts: 2 })]);
    const live = new LiveStrategist(transport);

    await live.update(brief);
    const usage = live.usage('draft-1')!;

    expect(usage).toMatchObject({
      draftId: 'draft-1',
      calls: 1,
      repairCalls: 1,
      inputTokens: 8500,
      cacheReadTokens: 5337,
      outputTokens: 1200,
    });
    // Cached reads bill at a tenth, so a single input figure would overstate it.
    expect(usage.estimatedCostUsd).toBeGreaterThan(0);
    expect(usage.estimatedCostUsd).toBeLessThan(
      ((8500 + 5337) * 15 + 1200 * 75) / 1e6,
    );
  });

  it('counts a failure without pretending it produced advice', async () => {
    const brief = ourTurn();
    const ledger = new UsageLedger();
    const { transport } = fakeTransport([result(brief, { response: null, error: 'nope' })]);
    const live = new LiveStrategist(transport, DEFAULT_CALL_POLICY, ledger);

    await live.update(brief);
    expect(ledger.get('draft-1')).toMatchObject({ calls: 1, failures: 1 });
  });

  it('keeps drafts apart, which is what a future cap will read', async () => {
    const ledger = new UsageLedger();
    const brief = ourTurn();
    ledger.record('draft-a', result(brief));
    ledger.record('draft-b', result(brief));
    ledger.record('draft-a', result(brief));

    expect(ledger.get('draft-a')!.calls).toBe(2);
    expect(ledger.get('draft-b')!.calls).toBe(1);
    expect(ledger.all()).toHaveLength(2);
  });
});
