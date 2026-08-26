/**
 * Drives a complete draft where Juancho-Fico always takes its own #1
 * recommendation.
 *
 * This is the acceptance harness for the question that actually matters: if a
 * human follows the top recommendation every single round, do they end up with
 * a coherent team? Everything else in the engine can look reasonable in
 * isolation and still fail here, because the failure mode is cumulative - each
 * pick is defensible on its own and the roster is nonsense.
 *
 * The room is driven by the real opponent model, and the user's seat calls the
 * real `generateDraftRecommendations`, so this exercises the production
 * decision path rather than a reimplementation of it.
 */
import type { DraftRoomRankingSnapshot } from '../../data/types';
import type { CanonicalPlayerMap, Position } from '../../players/types';
import type { MappedProjection } from '../../projections/types';
import type {
  SleeperDraft,
  SleeperDraftPick,
  SleeperLeague,
  SleeperRoster,
} from '../../sleeper/types';
import { normalizeLeagueContext } from '../context/normalize';
import type { LeagueContext } from '../context/types';
import { slotForOverallPick } from '../draft/next-pick-probability';
import { generateDraftRecommendations } from '../draft/recommendations';
import { deriveDraftBoardState } from '../draft/state';
import type { DraftRecommendation } from '../draft/types';
import {
  archetypeForRoster,
  chooseOpponentPlayer,
  type OpponentCandidate,
} from './opponent-model';

export type AutodraftDraftType = 'snake' | 'linear' | '3rr';

export interface AutodraftSpec {
  league: SleeperLeague;
  draft: SleeperDraft;
  rosters: SleeperRoster[];
  players: CanonicalPlayerMap;
  projections: MappedProjection[];
  roomRankings?: DraftRoomRankingSnapshot | null;
  /** 1-based seat the Juancho user occupies. */
  userSlot: number;
  userId: string;
  seed?: number;
}

/** One selection, with the reasoning captured when it was Juancho's pick. */
export interface AutodraftPick {
  overallPick: number;
  round: number;
  slot: number;
  rosterId: number;
  isUser: boolean;
  playerId: string;
  playerName: string;
  position: Position;
  /** Populated only for the user's own selections. */
  recommendation?: {
    score: number;
    action: DraftRecommendation['action'];
    availableNextPickProbability: number | null;
    nextPickConfidence: DraftRecommendation['nextPickConfidence'];
    tier: number;
    reasons: string[];
    components: DraftRecommendation['components'];
    vorp: number;
  };
  /** The top five the engine offered at this pick, for auditing. */
  top5?: { name: string; position: Position; score: number; action: string }[];
  /** Position counts on the user's roster BEFORE this pick was made. */
  rosterBefore?: Partial<Record<Position, number>>;
}

export interface AutodraftResult {
  picks: AutodraftPick[];
  userPicks: AutodraftPick[];
  userPositionCounts: Partial<Record<Position, number>>;
  userRoster: { name: string; position: Position; projection: number; round: number }[];
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function draftTypeOf(draft: SleeperDraft): AutodraftDraftType {
  return draft.type === 'linear' || draft.type === '3rr' ? draft.type : 'snake';
}

/**
 * Runs the whole draft.
 *
 * The board, the league context and the recommendations are all rebuilt from
 * the accumulated pick list at every user selection, exactly as the live app
 * rebuilds them when Sleeper reports a pick.
 */
export function autodraftWithRecommendationOne(spec: AutodraftSpec): AutodraftResult {
  const {
    league,
    draft,
    rosters,
    players,
    projections,
    roomRankings = null,
    userSlot,
    userId,
    seed = 20260826,
  } = spec;

  const random = mulberry32(seed);
  const teams = draft.settings.teams ?? rosters.length;
  const rounds = draft.settings.rounds ?? 15;
  const totalPicks = teams * rounds;
  const type = draftTypeOf(draft);

  const slotToRosterId = draft.slot_to_roster_id ?? null;
  const rosterIdForSlot = (slot: number): number =>
    slotToRosterId?.[String(slot)] ?? slot;
  const userRosterId = rosterIdForSlot(userSlot);

  const projectionByPlayerId = new Map(
    projections.map((projection) => [projection.playerId, projection]),
  );
  const roomByPlayerId = new Map(
    (roomRankings?.records ?? []).map((record) => [record.playerId, record]),
  );

  // Everyone still on the board, keyed by canonical player id.
  const available = new Map<string, MappedProjection>();
  for (const projection of projections) {
    const player = players.byId.get(projection.playerId);
    if (!player?.externalIds.sleeper) continue;
    if (!['QB', 'RB', 'WR', 'TE'].includes(projection.position)) continue;
    available.set(projection.playerId, projection);
  }

  const picks: SleeperDraftPick[] = [];
  const record: AutodraftPick[] = [];
  const recentPositions: Position[] = [];
  const countsByRoster = new Map<number, Partial<Record<Position, number>>>(
    rosters.map((roster) => [roster.roster_id, {}]),
  );

  let context: LeagueContext | null = null;

  for (let overallPick = 1; overallPick <= totalPicks; overallPick += 1) {
    const slot = slotForOverallPick(overallPick, teams, type);
    const rosterId = rosterIdForSlot(slot);
    const isUser = rosterId === userRosterId;
    const roundNumber = Math.ceil(overallPick / teams);
    const rosterCounts = countsByRoster.get(rosterId) ?? {};

    let chosen: MappedProjection | null = null;
    let recommendationDetail: AutodraftPick['recommendation'];
    let top5: AutodraftPick['top5'];
    let rosterBefore: Partial<Record<Position, number>> | undefined;

    if (isUser) {
      // Rebuild exactly what the live app would have in front of it.
      const board = deriveDraftBoardState(draft, picks, rosters, players);
      context = normalizeLeagueContext({
        league,
        draft,
        drafts: [draft],
        picks,
        tradedPicks: [],
        rosters,
        board,
        userId,
      });
      const result = generateDraftRecommendations({
        context,
        picks,
        rosters,
        board,
        players,
        projections,
        roomRankings,
      });
      const best = result.recommendations[0];
      rosterBefore = { ...rosterCounts };
      if (best) {
        chosen = projectionByPlayerId.get(best.player.id) ?? null;
        recommendationDetail = {
          score: best.score,
          action: best.action,
          availableNextPickProbability: best.availableNextPickProbability,
          nextPickConfidence: best.nextPickConfidence,
          tier: best.tier,
          reasons: best.reasons,
          components: best.components,
          vorp: best.raw.vorp,
        };
        top5 = result.recommendations.slice(0, 5).map((recommendation) => ({
          name: recommendation.player.name,
          position: recommendation.player.position,
          score: recommendation.score,
          action: recommendation.action,
        }));
      }
    } else {
      const candidates: OpponentCandidate[] = [...available.values()].map(
        (projection) => ({
          projection,
          roomRanking: roomByPlayerId.get(projection.playerId) ?? null,
        }),
      );
      chosen =
        chooseOpponentPlayer({
          candidates,
          archetype: archetypeForRoster(rosterId),
          counts: rosterCounts,
          roster: context?.roster.value ?? buildFallbackRoster(),
          currentPick: overallPick,
          recentPositions,
          random,
        })?.projection ?? null;
    }

    // Fall back to best available so a draft never stalls mid-run.
    if (!chosen) {
      chosen =
        [...available.values()].sort((a, b) => b.projection - a.projection)[0] ?? null;
    }
    if (!chosen) break;

    const player = players.byId.get(chosen.playerId);
    const sleeperId = player?.externalIds.sleeper;
    if (!sleeperId) {
      available.delete(chosen.playerId);
      continue;
    }

    available.delete(chosen.playerId);
    rosterCounts[chosen.position] = (rosterCounts[chosen.position] ?? 0) + 1;
    countsByRoster.set(rosterId, rosterCounts);
    recentPositions.push(chosen.position);

    picks.push({
      player_id: sleeperId,
      picked_by: isUser ? userId : `user-${rosterId}`,
      roster_id: String(rosterId),
      round: roundNumber,
      draft_slot: slot,
      pick_no: overallPick,
      metadata: { position: chosen.position },
    });

    record.push({
      overallPick,
      round: roundNumber,
      slot,
      rosterId,
      isUser,
      playerId: chosen.playerId,
      playerName: player?.name ?? chosen.playerName,
      position: chosen.position,
      recommendation: recommendationDetail,
      top5,
      rosterBefore,
    });
  }

  const userPicks = record.filter((pick) => pick.isUser);
  const userPositionCounts: Partial<Record<Position, number>> = {};
  for (const pick of userPicks) {
    userPositionCounts[pick.position] = (userPositionCounts[pick.position] ?? 0) + 1;
  }

  return {
    picks: record,
    userPicks,
    userPositionCounts,
    userRoster: userPicks.map((pick) => ({
      name: pick.playerName,
      position: pick.position,
      projection: projectionByPlayerId.get(pick.playerId)?.projection ?? 0,
      round: pick.round,
    })),
  };
}

/** Only used before the first user pick has built a real context. */
function buildFallbackRoster() {
  return {
    QB: 1,
    RB: 2,
    WR: 2,
    TE: 1,
    FLEX: 1,
    SUPER_FLEX: 0,
    K: 0,
    DEF: 0,
    bench: 6,
    taxi: 0,
    IR: 0,
    idp: {},
    unknown: {},
    totalStarterSpots: 7,
  };
}
