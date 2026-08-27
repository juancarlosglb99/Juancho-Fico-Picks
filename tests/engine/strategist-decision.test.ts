/**
 * Which recommendation actually gets shown.
 *
 * Two failure modes are being defended against. One is the race: a draft moves
 * while a strategist request is in flight, and advice about a board that no
 * longer exists must never quietly replace advice about the one that does. The
 * other is accountability - every outcome has to leave behind enough to answer
 * "why did it take X over First Seed's Y" weeks later.
 */
import { describe, expect, it } from 'vitest';
import { generateDraftRecommendations } from '../../packages/engine/draft/recommendations';
import { resolveStrategistDecision } from '../../packages/engine/strategist/audit';
import { buildDraftBrief } from '../../packages/engine/strategist/brief';
import { fingerprintBoard, stalenessOf } from '../../packages/engine/strategist/state-version';
import type {
  DraftBrief,
  StrategistAdvice,
} from '../../packages/engine/strategist/types';
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
  })!;
}

const adviceFor = (
  brief: DraftBrief,
  playerId: string,
  overrides: Partial<StrategistAdvice> = {},
): StrategistAdvice => ({
  state: brief.state,
  primary: {
    playerId,
    reasoning: 'The room is about to run on this position.',
    reasonCodes: ['tier_cliff'],
    confidence: 0.7,
  },
  alternatives: [],
  roomRead: 'Two teams ahead of us need a running back.',
  confidence: 0.7,
  ...overrides,
});

describe('board state versioning', () => {
  it('fingerprints the drafted set, not just its size', () => {
    expect(fingerprintBoard(['1', '2', '3'])).toBe(fingerprintBoard(['1', '2', '3']));
    expect(fingerprintBoard(['1', '2', '3'])).not.toBe(fingerprintBoard(['1', '3', '2']));
    // A corrected pick keeps the count and must still be a different board.
    expect(fingerprintBoard(['1', '2', '3'])).not.toBe(fingerprintBoard(['1', '2', '4']));
    // And an id boundary is a real boundary.
    expect(fingerprintBoard(['1', '23'])).not.toBe(fingerprintBoard(['12', '3']));
  });

  it('names why a state no longer applies', () => {
    const at20 = briefAfter(20).state;
    const at22 = briefAfter(22).state;
    expect(stalenessOf(at20, at20)).toBeNull();
    expect(stalenessOf(at20, at22)).toBe('board_advanced');
    expect(stalenessOf(at22, at20)).toBe('board_rewound');
    expect(stalenessOf({ ...at20, draftId: 'other' }, at20)).toBe('different_draft');
    expect(stalenessOf({ ...at20, boardFingerprint: 'tampered' }, at20)).toBe('board_diverged');
  });
});

describe('resolving a decision', () => {
  it('falls back to the deterministic pick when no strategist ran', () => {
    const brief = briefAfter(20);
    const decision = resolveStrategistDecision({ brief, advice: null });
    expect(decision.outcome).toBe('ai_unavailable');
    expect(decision.final).toMatchObject({
      playerId: brief.deterministic.recommended!.playerId,
      source: 'deterministic',
    });
  });

  it('never applies advice about a board that has moved', () => {
    const older = briefAfter(20);
    const current = briefAfter(24);
    const stale = adviceFor(older, older.candidates[3].playerId);

    const decision = resolveStrategistDecision({ brief: current, advice: stale });
    expect(decision.outcome).toBe('ai_stale');
    expect(decision.audit.staleness).toBe('board_advanced');
    expect(decision.final!.source).toBe('deterministic');
  });

  it('reports agreement with the deterministic engine as confirmation', () => {
    const brief = briefAfter(20);
    const decision = resolveStrategistDecision({
      brief,
      advice: adviceFor(brief, brief.deterministic.recommended!.playerId),
    });
    expect(decision.outcome).toBe('ai_confirmed');
    expect(decision.final!.source).toBe('strategist');
  });

  it('lets the strategist override the deterministic engine', () => {
    const brief = briefAfter(20);
    const other = brief.candidates.find(
      (candidate) => candidate.playerId !== brief.deterministic.recommended!.playerId,
    )!;
    const decision = resolveStrategistDecision({ brief, advice: adviceFor(brief, other.playerId) });
    expect(decision.outcome).toBe('ai_override');
    expect(decision.final).toMatchObject({ playerId: other.playerId, source: 'strategist' });
  });

  it('falls back when the strategist names a player who is gone', () => {
    const brief = briefAfter(20);
    const decision = resolveStrategistDecision({
      brief,
      advice: adviceFor(brief, brief.room.allDraftedPlayerIds[0]),
    });
    expect(decision.outcome).toBe('ai_rejected');
    expect(decision.final!.source).toBe('deterministic');
    expect(decision.audit.guardrail!.violations[0].code).toBe('already_drafted');
  });

  it('holds its second answer back unless asked to use it', () => {
    const brief = briefAfter(20);
    const legal = brief.candidates.find(
      (candidate) => candidate.playerId !== brief.deterministic.recommended!.playerId,
    )!;
    const advice = adviceFor(brief, brief.room.allDraftedPlayerIds[0], {
      alternatives: [
        {
          playerId: legal.playerId,
          reasoning: 'Second choice.',
          reasonCodes: ['starter_need'],
          confidence: 0.5,
        },
      ],
    });

    expect(resolveStrategistDecision({ brief, advice }).outcome).toBe('ai_rejected');

    const permissive = resolveStrategistDecision({
      brief,
      advice,
      allowAlternativeFallback: true,
    });
    expect(permissive.outcome).toBe('ai_alternative');
    expect(permissive.final).toMatchObject({ playerId: legal.playerId, source: 'strategist' });
  });

  it('records enough to answer "why this player over First Seed\'s"', () => {
    const brief = briefAfter(20);
    const other = brief.candidates.find(
      (candidate) => candidate.playerId !== brief.deterministic.recommended!.playerId,
    )!;
    const { audit } = resolveStrategistDecision({
      brief,
      advice: adviceFor(brief, other.playerId),
      latencyMs: 1420,
      strategistId: 'test-client',
    });

    expect(audit.state).toEqual(brief.state);
    expect(audit.brief).toBe(brief);
    expect(audit.deterministic).toEqual(brief.deterministic.recommended);
    expect(audit.advice!.primary.playerId).toBe(other.playerId);
    expect(audit.adviceConfidence).toBe(0.7);
    expect(audit.reasons[0]).toMatchObject({ reasonCodes: ['tier_cliff'] });
    expect(audit.guardrail).not.toBeNull();
    expect(audit.final).toMatchObject({ playerId: other.playerId });
    expect(audit.latencyMs).toBe(1420);
    expect(audit.strategistId).toBe('test-client');
    // And First Seed's own best available is in the brief the record carries.
    expect(audit.brief.deterministic.bestAvailableFirstSeed).not.toBeNull();
  });
});
