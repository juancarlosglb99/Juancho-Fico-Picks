/**
 * A real draft, frozen so it can be replayed forever.
 *
 * Every mock that gets run becomes a permanent regression case. The point is
 * not to record what the engine said - that changes, and should - but to record
 * the exact situation it faced, so a future engine can be put in the same seat
 * and compared honestly.
 *
 * That means the projection and draft-room snapshots are stored WITH the case.
 * First Seed republishes weekly; without pinning the data, a replay six weeks
 * later would compare two engines on two different boards and call the
 * difference an improvement.
 */
import type { DraftRoomRankingSnapshot, ProjectionSnapshot } from '../../data/types';
import type { CanonicalPlayerMap, Position } from '../../players/types';
import type { SleeperDraft, SleeperDraftPick, SleeperLeague, SleeperRoster } from '../../sleeper/types';
import { normalizeLeagueContext } from '../context/normalize';
import { generateDraftRecommendations } from '../draft/recommendations';
import { deriveDraftBoardState } from '../draft/state';
import { lineupSlotsFor, type LineupPlayer } from '../draft/lineup';
import { measure } from '../perf/latency';
import {
  scoreDecision,
  scoreRoster,
  summarizeDraftQuality,
  type DraftQualityReport,
} from './quality';
import {
  auditPick,
  summarizeDeviations,
  type DeviationRecord,
  type DeviationSummary,
} from './deviation';

/** Bumped when the stored shape changes in a way old files cannot satisfy. */
export const REGRESSION_CASE_VERSION = 1;

export interface RegressionFormat {
  teams: number;
  rounds: number;
  scoringProfile: string;
  qbFormat: string;
  draftType: string;
  leagueType: string;
  isMock: boolean;
  rosterSlots: Record<string, number>;
}

/** What the engine said at one of our selections, at capture time. */
export interface RecordedDecision {
  overallPick: number;
  round: number;
  /** What the engine recommended then. */
  recommended: { playerId: string; name: string; position: Position; score: number } | null;
  action: string | null;
  availableNextPickProbability: number | null;
  /** What the human actually selected in the real draft. */
  actual: { playerId: string | null; name: string; position: string };
  /** Strategy state at that moment. */
  strategy: {
    build: string;
    strategicPriority: string[];
    positionCounts: Partial<Record<Position, number>>;
    unfilledStarterSlots: number;
  };
}

export interface RegressionCase {
  version: number;
  capturedAt: string;
  draftId: string;
  draftUrl: string;
  userId: string;
  username: string;
  userSlot: number;
  format: RegressionFormat;
  /** The whole board, in draft order. Needed to replay any seat. */
  picks: SleeperDraftPick[];
  /** Our selections in the real draft, for the actual-versus-recommended view. */
  actualRoster: { overallPick: number; round: number; name: string; position: string }[];
  /**
   * Pinned source data, referenced rather than inlined.
   *
   * Every mock drafted in the same week shares the same First Seed snapshot, and
   * inlining it made a single case 300KB. The reference points at a file in
   * `data/regression/snapshots/`, so a season of mocks costs one copy of the
   * data rather than fifty.
   */
  projectionsRef: string;
  roomRankingsRef: string | null;
  /**
   * The draftable player pool, also pinned.
   *
   * Rebuilding this from the projections and the picks is not equivalent: the
   * pool decides who is available, which decides the kicker and defense
   * candidates and the whole ranking. A replay against a reconstructed pool
   * produced a different roster from the capture, which would make the corpus
   * quietly useless.
   */
  playersRef: string;
  /** The engine's behaviour when the case was captured, as a baseline. */
  baseline: {
    decisions: RecordedDecision[];
    finalRoster: { name: string; position: Position; round: number }[];
    quality: {
      startingValue: number;
      benchValue: number;
      unfilledSlots: number;
      total: number;
      unusableDepth: number;
      counts: Partial<Record<Position, number>>;
      totalRegret: number;
      meanRegret: number;
    };
  };
}

export interface ReplayInput {
  regression: RegressionCase;
  /** Resolved from `projectionsRef`. */
  projections: ProjectionSnapshot;
  /** Resolved from `roomRankingsRef`. */
  roomRankings: DraftRoomRankingSnapshot | null;
  players: CanonicalPlayerMap;
  league: SleeperLeague;
  draft: SleeperDraft;
  rosters: SleeperRoster[];
}

export interface ReplayResult {
  decisions: RecordedDecision[];
  finalRoster: { name: string; position: Position; round: number }[];
  quality: DraftQualityReport;
  /** Milliseconds to produce recommendations, per selection. */
  computeMs: number[];
  contradictions: string[];
  /** How far each pick strayed from First Seed, and whether it paid. */
  deviations: DeviationRecord[];
  deviationSummary: DeviationSummary;
}

/**
 * Replays a saved case against the CURRENT engine.
 *
 * Only our own selections are replaced. Everything the room did is kept exactly
 * as it happened, so the engine faces the board a person actually faced rather
 * than a board of its own making.
 */
export function replayRegressionCase(input: ReplayInput): ReplayResult {
  const { regression, players, league, draft, rosters, projections, roomRankings } = input;
  const ordered = [...regression.picks].sort((a, b) => a.pick_no - b.pick_no);
  const ourPickNumbers = ordered
    .filter((pick) => pick.draft_slot === regression.userSlot)
    .map((pick) => pick.pick_no);

  const projectionById = new Map(
    projections.records.map((record) => [record.playerId, record]),
  );
  const nameOf = (playerId: string) =>
    players.byId.get(playerId)?.name ?? projectionById.get(playerId)?.playerName ?? playerId;

  const board0 = deriveDraftBoardState(draft, [], rosters, players);
  const context0 = normalizeLeagueContext({
    league,
    draft,
    drafts: [draft],
    picks: [],
    tradedPicks: [],
    rosters,
    board: board0,
    userId: regression.userId,
  });
  const slots = lineupSlotsFor(context0.roster.value);

  const decisions: RecordedDecision[] = [];
  const computeMs: number[] = [];
  const contradictions: string[] = [];
  const deviations: DeviationRecord[] = [];
  const roomRankByPlayer = new Map(
    (roomRankings?.records ?? []).map((record) => [record.playerId, record.rank]),
  );
  const qualitySamples: Parameters<typeof scoreDecision>[0][] = [];
  const ourRoster: LineupPlayer[] = [];
  const takenByUs: string[] = [];

  for (const overallPick of ourPickNumbers) {
    // The room's real picks, plus our own replacements so far.
    const roomBefore = ordered.filter(
      (pick) => pick.pick_no < overallPick && pick.draft_slot !== regression.userSlot,
    );
    const oursBefore = ordered
      .filter((pick) => pick.draft_slot === regression.userSlot && pick.pick_no < overallPick)
      .map((pick, index) => ({ ...pick, player_id: takenByUs[index] ?? pick.player_id }));
    const picksBefore = [...roomBefore, ...oursBefore].sort((a, b) => a.pick_no - b.pick_no);

    const board = deriveDraftBoardState(draft, picksBefore, rosters, players);
    const context = normalizeLeagueContext({
      league,
      draft,
      drafts: [draft],
      picks: picksBefore,
      tradedPicks: [],
      rosters,
      board,
      userId: regression.userId,
    });

    const { value: result, ms } = measure(() =>
      generateDraftRecommendations({
        context,
        picks: picksBefore,
        rosters,
        board,
        players,
        projections: projections.records,
        roomRankings,
      }),
    );
    computeMs.push(ms);

    const best = result.recommendations[0] ?? null;
    const actualPick = ordered.find((pick) => pick.pick_no === overallPick)!;
    const round = actualPick.round;

    /*
     * First Seed's best available, found from the whole board rather than the
     * engine's shortlist - so a player the engine never even considered still
     * shows up in the audit.
     */
    let firstSeedBestId: string | null = null;
    let firstSeedBestRank = Number.POSITIVE_INFINITY;
    for (const player of board.availablePlayers) {
      const rank = roomRankByPlayer.get(player.id);
      if (rank === undefined) continue;
      if (rank < firstSeedBestRank) {
        firstSeedBestRank = rank;
        firstSeedBestId = player.id;
      }
    }
    const deviation = auditPick({
      overallPick,
      round,
      recommendations: result.recommendations,
      firstSeedBestId,
      firstSeedBestName: firstSeedBestId
        ? players.byId.get(firstSeedBestId)?.name ?? firstSeedBestId
        : undefined,
      firstSeedBestRank: Number.isFinite(firstSeedBestRank) ? firstSeedBestRank : null,
      firstSeedBestProjectable: firstSeedBestId
        ? projectionById.has(firstSeedBestId)
        : true,
    });
    if (deviation) deviations.push(deviation);

    if (
      best &&
      best.action === 'DRAFT_NOW' &&
      best.availableNextPickProbability !== null &&
      best.availableNextPickProbability >= 90 &&
      !best.insight.exceptionalReason
    ) {
      contradictions.push(
        `pick ${overallPick}: ${best.player.name} DRAFT_NOW at ${best.availableNextPickProbability}%`,
      );
    }

    const rosterBefore = [...ourRoster];
    if (best) {
      const sleeperId = best.player.externalIds.sleeper;
      if (sleeperId) takenByUs.push(sleeperId);
      /*
       * Take the value the ENGINE used, not a second lookup.
       *
       * Kickers and defenses are not in the projection snapshot - nobody
       * publishes projections for them - so looking them up here scored them at
       * zero while the First Seed baseline gave them a nominal value. That made
       * the comparison read as a 234-point loss for the strategy engine when it
       * was actually slightly ahead, and very nearly bought a fix for a problem
       * that did not exist.
       */
      const chosen: LineupPlayer = {
        playerId: best.player.id,
        position: best.player.position,
        projection: best.raw.projectedPoints,
      };
      ourRoster.push(chosen);

      qualitySamples.push({
        overallPick,
        round,
        chosen,
        rosterBefore,
        available: board.availablePlayers
          .map((player) => {
            const projection = projectionById.get(player.id);
            return projection
              ? {
                  playerId: player.id,
                  position: player.position,
                  projection: projection.projection,
                }
              : null;
          })
          .filter((entry): entry is LineupPlayer => entry !== null),
      });
    }

    decisions.push({
      overallPick,
      round,
      recommended: best
        ? {
            playerId: best.player.id,
            name: best.player.name,
            position: best.player.position,
            score: best.score,
          }
        : null,
      action: best?.action ?? null,
      availableNextPickProbability: best?.availableNextPickProbability ?? null,
      actual: {
        playerId: players.bySleeperId.get(actualPick.player_id)?.id ?? null,
        name: `${actualPick.metadata.first_name ?? ''} ${actualPick.metadata.last_name ?? ''}`.trim(),
        position: actualPick.metadata.position ?? 'UNKNOWN',
      },
      strategy: {
        build: best?.insight.build ?? 'undefined',
        strategicPriority: best?.insight.strategicPriority ?? [],
        positionCounts: countPositions(rosterBefore),
        unfilledStarterSlots: best?.insight.expectedUnfilledSlots ?? 0,
      },
    });
  }

  const roster = scoreRoster(ourRoster, slots);
  const decisionQuality = qualitySamples.map((sample) => scoreDecision(sample, slots, nameOf));

  return {
    decisions,
    finalRoster: ourRoster.map((player, index) => ({
      name: nameOf(player.playerId),
      position: player.position,
      round: decisions[index]?.round ?? 0,
    })),
    quality: summarizeDraftQuality(roster, decisionQuality),
    computeMs,
    contradictions,
    deviations,
    deviationSummary: summarizeDeviations(deviations),
  };
}

function countPositions(players: LineupPlayer[]): Partial<Record<Position, number>> {
  const counts: Partial<Record<Position, number>> = {};
  for (const player of players) {
    counts[player.position] = (counts[player.position] ?? 0) + 1;
  }
  return counts;
}
