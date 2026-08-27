/**
 * What the strategist may and may not be stopped from doing.
 *
 * The line these tests defend runs in both directions, and the second half
 * matters as much as the first. Objectively invalid picks are blocked. Picks
 * the deterministic engine merely disagrees with are NOT - reaching past First
 * Seed, giving up plan value, giving a reason our audit has no word for. Those
 * are the strategic judgements the layer exists to make, so blocking them would
 * make it an expensive way to reproduce the engine.
 */
import { describe, expect, it } from 'vitest';
import { generateDraftRecommendations } from '../../packages/engine/draft/recommendations';
import { buildDraftBrief } from '../../packages/engine/strategist/brief';
import { validateStrategistPick } from '../../packages/engine/strategist/guardrails';
import { buildCanonicalPlayerMap } from '../../packages/players/player-map';
import type { Position } from '../../packages/players/types';
import type { SleeperDraftPick, SleeperPlayersResponse } from '../../packages/sleeper/types';
import type { DraftBrief, StrategistPick } from '../../packages/engine/strategist/types';
import {
  makeContext,
  makeDraft,
  makeLeague,
  makeProjections,
  makeRoomRankings,
  makeRosters,
} from './fixtures';

const TEAMS = 12;
const POSITIONS: Position[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

/** A pool with kickers and defenses, which the shared fixture omits. */
const players = (() => {
  const raw: SleeperPlayersResponse = {};
  let id = 1;
  for (const position of POSITIONS) {
    for (let index = 0; index < 40; index += 1) {
      raw[String(id)] = {
        player_id: String(id),
        full_name: `${position} Player ${index + 1}`,
        position,
        team: 'TST',
        years_exp: 3,
        age: 26,
      };
      id += 1;
    }
  }
  return buildCanonicalPlayerMap(raw);
})();

const projections = makeProjections(players).filter(
  (projection) => projection.position !== 'K' && projection.position !== 'DEF',
);
// Every real draft has a published board to anchor to, and the engine behaves
// deliberately differently without one, so the scenario supplies it.
const roomRankings = makeRoomRankings(projections);

const slotOf = (overall: number, teams = TEAMS) => {
  const round = Math.ceil(overall / teams);
  const pickInRound = ((overall - 1) % teams) + 1;
  return round % 2 === 0 ? teams + 1 - pickInRound : pickInRound;
};

/**
 * A board drafted to `through`, with our seat forced onto given positions.
 *
 * Everybody else takes the best projected player left, which is enough to
 * produce a realistic room without pinning the test to a particular ordering.
 */
function scenario({
  through,
  rounds = 16,
  rosterPositions,
  ourPositions = [],
}: {
  through: number;
  rounds?: number;
  rosterPositions?: string[];
  ourPositions?: Position[];
}) {
  const ranked = [...projections].sort((a, b) => b.projection - a.projection);
  const taken = new Set<string>();
  const picks: SleeperDraftPick[] = [];
  let ourIndex = 0;

  for (let overall = 1; overall <= through; overall += 1) {
    const slot = slotOf(overall);
    const wanted = slot === 1 ? ourPositions[ourIndex++] : undefined;
    const choice = ranked.find(
      (entry) => !taken.has(entry.playerId) && (!wanted || entry.position === wanted),
    );
    if (!choice) continue;
    taken.add(choice.playerId);
    picks.push({
      player_id: players.byId.get(choice.playerId)!.externalIds.sleeper!,
      picked_by: `user-${slot}`,
      roster_id: String(slot),
      round: Math.ceil(overall / TEAMS),
      draft_slot: slot,
      pick_no: overall,
      metadata: {},
    });
  }

  const league = makeLeague({ teams: TEAMS, rosterPositions });
  const draft = makeDraft({ teams: TEAMS, rounds });
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
  const brief = buildDraftBrief({
    context,
    board,
    picks,
    rosters,
    players,
    result,
    draftId: 'draft-1',
  });
  return { brief: brief!, picks };
}

const advise = (playerId: string, overrides: Partial<StrategistPick> = {}): StrategistPick => ({
  playerId,
  reasoning: 'Best fit for the roster we are building.',
  reasonCodes: ['starter_need'],
  confidence: 0.8,
  ...overrides,
});

const firstAt = (brief: DraftBrief, position: Position) =>
  brief.candidates.find((candidate) => candidate.position === position)!;

/* ------------------------------------------------------------ hard blocks */

describe('guardrails block objectively invalid picks', () => {
  it('rejects a player who has already been drafted', () => {
    const { brief } = scenario({ through: 30 });
    const drafted = brief.room.allDraftedPlayerIds[0];
    const result = validateStrategistPick(advise(drafted), brief);
    expect(result.ok).toBe(false);
    expect(result.violations.map((violation) => violation.code)).toContain('already_drafted');
  });

  it('rejects a player who is not in the pool at all', () => {
    const { brief } = scenario({ through: 30 });
    const result = validateStrategistPick(advise('invented-player'), brief);
    expect(result.ok).toBe(false);
    expect(result.violations.map((violation) => violation.code)).toContain('not_in_candidate_pool');
  });

  it('rejects a third quarterback in a one-quarterback league', () => {
    const { brief } = scenario({ through: 30, ourPositions: ['QB', 'QB', 'RB'] });
    expect(brief.ourTeam.positionCounts.QB).toBe(2);
    const result = validateStrategistPick(advise(firstAt(brief, 'QB').playerId), brief);
    expect(result.ok).toBe(false);
    expect(result.violations.map((violation) => violation.code)).toContain('meaningless_stack');
  });

  it('rejects a kicker before the closing rounds', () => {
    const { brief } = scenario({
      through: 30,
      rosterPositions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF', 'BN', 'BN', 'BN'],
    });
    expect(brief.constraints.kickersAndDefensesAllowed).toBe(false);
    // A kicker is not in the pool this early, which is itself the block.
    const result = validateStrategistPick(advise('7-k-player-1'), brief);
    expect(result.ok).toBe(false);
  });

  it('rejects a pick that leaves a starting slot unfillable', () => {
    const { brief } = scenario({
      through: 72,
      rounds: 8,
      rosterPositions: ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'K', 'DEF'],
      // Every starting slot filled except the two nobody projects.
      ourPositions: ['RB', 'RB', 'WR', 'WR', 'TE', 'QB'],
    });
    expect(brief.draft.picksRemaining).toBe(2);
    expect(brief.constraints.mustFillBeforeDraftEnds.map((entry) => entry.position).sort()).toEqual([
      'DEF',
      'K',
    ]);

    const receiver = firstAt(brief, 'WR');
    const result = validateStrategistPick(advise(receiver.playerId), brief);
    expect(result.ok).toBe(false);
    expect(result.violations.map((violation) => violation.code)).toContain(
      'impossible_roster_construction',
    );

    // And the kicker that resolves it is still perfectly legal.
    const kicker = firstAt(brief, 'K');
    expect(validateStrategistPick(advise(kicker.playerId), brief).ok).toBe(true);
  });
});

/* ------------------------------------------ strategic disagreement is allowed */

describe('guardrails do not block strategic disagreement', () => {
  it('allows a reach far past First Seed, and records it', () => {
    const { brief } = scenario({ through: 20 });
    const reach = [...brief.candidates]
      .filter((candidate) => (candidate.firstSeed.rankGapFromBestAvailable ?? 0) >= 10)
      .sort(
        (a, b) =>
          (b.firstSeed.rankGapFromBestAvailable ?? 0) - (a.firstSeed.rankGapFromBestAvailable ?? 0),
      )[0];
    expect(reach, 'the pool should contain someone well down the board').toBeTruthy();

    const result = validateStrategistPick(advise(reach.playerId), brief);
    expect(result.ok, 'reaching is a judgement, not an invalid move').toBe(true);
    expect(result.concerns.map((concern) => concern.code)).toContain('reaches_past_first_seed');
  });

  it('allows a pick the deterministic simulation rates worse, and records it', () => {
    const { brief } = scenario({ through: 20 });
    const worse = brief.candidates
      .filter((candidate) => (candidate.juancho.planValueVsRecommended ?? 0) < -10)
      .sort((a, b) => (a.juancho.planValueVsRecommended ?? 0) - (b.juancho.planValueVsRecommended ?? 0))[0];
    expect(worse, 'the pool should contain someone Juancho plans worse').toBeTruthy();

    const result = validateStrategistPick(advise(worse.playerId), brief);
    expect(result.ok, 'the simulation is not the authority here').toBe(true);
    expect(result.concerns.map((concern) => concern.code)).toContain('deterministic_prefers_other');
  });

  it('allows a reason our deviation vocabulary has no word for', () => {
    const { brief } = scenario({ through: 20 });
    const result = validateStrategistPick(
      advise(brief.candidates[0].playerId, { reasonCodes: ['bye_week_stacking', 'coaching_change'] }),
      brief,
    );
    expect(result.ok).toBe(true);
    expect(
      result.concerns.filter((concern) => concern.code === 'unrecognized_reason_code'),
    ).toHaveLength(2);
  });

  it('records urgency that contradicts our own survival estimate', () => {
    const { brief } = scenario({ through: 11 });
    const certain = brief.candidates.find(
      (candidate) =>
        (candidate.survival.probability ?? 0) >= 90 && candidate.survival.confidence === 'high',
    );
    if (!certain) return;
    const result = validateStrategistPick(
      advise(certain.playerId, { reasoning: 'Take him now, he will be gone.' }),
      brief,
    );
    expect(result.ok).toBe(true);
    expect(result.concerns.map((concern) => concern.code)).toContain(
      'contradicts_survival_estimate',
    );
  });

  it('passes an ordinary, sensible pick with nothing to report', () => {
    const { brief } = scenario({ through: 20 });
    const recommended = brief.deterministic.recommended!;
    const result = validateStrategistPick(advise(recommended.playerId), brief);
    expect(result.ok).toBe(true);
    expect(result.concerns.map((concern) => concern.code)).not.toContain(
      'deterministic_prefers_other',
    );
  });
});
