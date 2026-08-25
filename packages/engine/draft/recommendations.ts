import type { CanonicalPlayer, CanonicalPlayerMap, Position } from '../../players/types';
import type { MappedProjection } from '../../projections/types';
import type {
  SleeperDraft,
  SleeperDraftPick,
  SleeperRoster,
} from '../../sleeper/types';
import { clamp, percentileScores, round } from './math';
import {
  findNextUserSelection,
  getInterveningDraftSlots,
  probabilityAvailableAtNextPick,
  resolveUserDraftSlot,
} from './next-pick-probability';
import {
  getRosterPositionCounts,
  getStarterTargets,
  getUserRosterId,
  scoreRosterFit,
} from './roster-fit';
import { buildProjectionTiers } from './tiers';
import {
  DRAFT_SCORE_WEIGHTS,
  type DraftBoardState,
  type DraftRecommendation,
  type DraftRecommendationResult,
  type DraftScoreComponents,
} from './types';

interface RecommendationInput {
  draft: SleeperDraft;
  picks: SleeperDraftPick[];
  rosters: SleeperRoster[];
  board: DraftBoardState;
  players: CanonicalPlayerMap;
  projections: MappedProjection[];
  userId: string;
}

interface RawCandidate {
  player: CanonicalPlayer;
  projection: MappedProjection;
  vorp: number;
  replacementProjection: number;
  scarcityGap: number;
  adpDelta: number;
  rosterFit: number;
  availableNextPickProbability: number;
  tier: number;
  playersRemainingInTier: number;
  gapAfterTier: number;
}

const CORE_POSITIONS = new Set<Position>(['QB', 'RB', 'WR', 'TE']);

function replacementDemand(position: Position, draft: SleeperDraft, teams: number) {
  const flex = Math.max(0, draft.settings.slots_flex ?? 1);
  const superFlex = Math.max(0, draft.settings.slots_super_flex ?? 0);
  const perTeam =
    position === 'QB'
      ? (draft.settings.slots_qb ?? 1) + superFlex * 0.7
      : position === 'RB'
        ? (draft.settings.slots_rb ?? 2) + flex * 0.42
        : position === 'WR'
          ? (draft.settings.slots_wr ?? 2) + flex * 0.48
          : position === 'TE'
            ? (draft.settings.slots_te ?? 1) + flex * 0.1
            : position === 'K'
              ? draft.settings.slots_k ?? 1
              : position === 'DEF'
                ? draft.settings.slots_def ?? 1
                : 1;
  return Math.max(1, Math.ceil(perTeam * teams));
}

function getReplacementProjections(
  projections: MappedProjection[],
  draft: SleeperDraft,
  teams: number,
): Map<Position, number> {
  const positions = new Map<Position, MappedProjection[]>();
  for (const projection of projections) {
    positions.set(projection.position, [
      ...(positions.get(projection.position) ?? []),
      projection,
    ]);
  }

  const replacements = new Map<Position, number>();
  for (const [position, records] of positions) {
    const sorted = [...records].sort((a, b) => b.projection - a.projection);
    const index = Math.min(
      sorted.length - 1,
      replacementDemand(position, draft, teams) - 1,
    );
    replacements.set(position, sorted[Math.max(0, index)]?.projection ?? 0);
  }
  return replacements;
}

function uniqueProjectionRecords(records: MappedProjection[]): MappedProjection[] {
  const byPlayer = new Map<string, MappedProjection>();
  for (const record of records) {
    const current = byPlayer.get(record.playerId);
    if (!current || record.rank < current.rank) byPlayer.set(record.playerId, record);
  }
  return [...byPlayer.values()];
}

function rosterIdByDraftSlot(
  draft: SleeperDraft,
  picks: SleeperDraftPick[],
): Map<number, number> {
  const result = new Map<number, number>();
  for (const [slot, rosterId] of Object.entries(draft.slot_to_roster_id ?? {})) {
    result.set(Number(slot), Number(rosterId));
  }
  for (const pick of picks) {
    if (!result.has(pick.draft_slot)) {
      result.set(pick.draft_slot, Number(pick.roster_id));
    }
  }
  return result;
}

function buildReasons(candidate: RawCandidate): string[] {
  const reasons: string[] = [];
  if (candidate.availableNextPickProbability <= 45) {
    reasons.push(
      `Only ${Math.round(candidate.availableNextPickProbability)}% chance to make it back`,
    );
  } else {
    reasons.push(
      `${Math.round(candidate.availableNextPickProbability)}% chance to make it back`,
    );
  }
  reasons.push(
    `${candidate.vorp >= 0 ? '+' : ''}${candidate.vorp.toFixed(1)} VORP over ${candidate.player.position} replacement`,
  );
  reasons.push(
    candidate.playersRemainingInTier === 1
      ? `Final player remaining in Tier ${candidate.tier}`
      : `${candidate.playersRemainingInTier} players remain in Tier ${candidate.tier}`,
  );
  if (candidate.rosterFit >= 82) {
    reasons.push(`${candidate.player.position} fills an open starting need`);
  }
  if (candidate.adpDelta >= 5) {
    reasons.push(`${Math.round(candidate.adpDelta)} picks past market ADP`);
  }
  return reasons.slice(0, 4);
}

function scoreCandidate(
  components: DraftScoreComponents,
): number {
  return round(
    components.vorp * DRAFT_SCORE_WEIGHTS.vorp +
      components.nextPickRisk * DRAFT_SCORE_WEIGHTS.nextPickRisk +
      components.tierUrgency * DRAFT_SCORE_WEIGHTS.tierUrgency +
      components.projection * DRAFT_SCORE_WEIGHTS.projection +
      components.rosterFit * DRAFT_SCORE_WEIGHTS.rosterFit +
      components.adpValue * DRAFT_SCORE_WEIGHTS.adpValue +
      components.scarcity * DRAFT_SCORE_WEIGHTS.scarcity,
    1,
  );
}

export function generateDraftRecommendations({
  draft,
  picks,
  rosters,
  board,
  players,
  projections: inputProjections,
  userId,
}: RecommendationInput): DraftRecommendationResult {
  const projections = uniqueProjectionRecords(inputProjections);
  const userRosterId = getUserRosterId(rosters, userId);
  const userDraftSlot = resolveUserDraftSlot(
    draft,
    userId,
    userRosterId,
    picks,
  );
  const nextUserPick = findNextUserSelection(
    board.currentOverallPick,
    board.teams,
    board.rounds,
    draft.type,
    userDraftSlot,
  );
  const picksUntilNextUserPick = Math.max(
    0,
    nextUserPick - board.currentOverallPick,
  );
  const availableIds = new Set(
    board.availablePlayers.map((player) => player.id),
  );
  const allowKickersAndDefense =
    board.currentRound >= Math.max(1, board.rounds - 2);
  const candidates = projections.filter(
    (projection) =>
      availableIds.has(projection.playerId) &&
      (CORE_POSITIONS.has(projection.position) ||
        (allowKickersAndDefense && ['K', 'DEF'].includes(projection.position))),
  );

  if (candidates.length === 0) {
    return {
      recommendations: [],
      nextUserPick,
      picksUntilNextUserPick,
      userDraftSlot,
      userRosterId,
    };
  }

  const tiers = buildProjectionTiers(projections);
  const replacements = getReplacementProjections(
    projections,
    draft,
    board.teams,
  );
  const targets = getStarterTargets(draft);
  const userCounts =
    userRosterId === null
      ? {}
      : getRosterPositionCounts(userRosterId, picks, rosters, players);
  const interveningSlots = getInterveningDraftSlots(
    board.currentOverallPick,
    nextUserPick,
    board.teams,
    draft.type,
  ).filter((slot) => slot !== userDraftSlot);
  const slotToRoster = rosterIdByDraftSlot(draft, picks);
  const rosterCounts = new Map(
    rosters.map((roster) => [
      roster.roster_id,
      getRosterPositionCounts(roster.roster_id, picks, rosters, players),
    ]),
  );

  const availableByPosition = new Map<Position, MappedProjection[]>();
  for (const projection of candidates) {
    availableByPosition.set(projection.position, [
      ...(availableByPosition.get(projection.position) ?? []),
      projection,
    ]);
  }
  for (const [position, records] of availableByPosition) {
    availableByPosition.set(
      position,
      [...records].sort((a, b) => b.projection - a.projection),
    );
  }

  const rawCandidates: RawCandidate[] = candidates.flatMap((projection) => {
    const player = players.byId.get(projection.playerId);
    if (!player) return [];
    const tierInfo = tiers.get(projection.playerId) ?? {
      tier: 1,
      tierSize: 1,
      gapAfterTier: 0,
    };
    const positionPool = availableByPosition.get(projection.position) ?? [];
    const positionIndex = positionPool.findIndex(
      (record) => record.playerId === projection.playerId,
    );
    const lookahead = Math.max(1, Math.min(4, Math.ceil(board.teams / 3)));
    const nextAtPosition = positionPool[positionIndex + lookahead];
    const scarcityGap = Math.max(
      0,
      projection.projection -
        (nextAtPosition?.projection ?? replacements.get(projection.position) ?? 0),
    );
    const playersRemainingInTier = positionPool.filter(
      (record) => tiers.get(record.playerId)?.tier === tierInfo.tier,
    ).length;
    const baseTarget =
      projection.position === 'QB'
        ? targets.QB
        : projection.position === 'RB'
          ? targets.RB
          : projection.position === 'WR'
            ? targets.WR
            : projection.position === 'TE'
              ? targets.TE
              : projection.position === 'K'
                ? targets.K
                : targets.DEF;
    const interveningDemand = interveningSlots.reduce((sum, slot) => {
      const rosterId = slotToRoster.get(slot);
      if (!rosterId) return sum + 0.35;
      const count = rosterCounts.get(rosterId)?.[projection.position] ?? 0;
      return sum + (count < baseTarget ? 1 : 0.15);
    }, 0);
    const replacementProjection =
      replacements.get(projection.position) ?? projection.projection;

    return [
      {
        player,
        projection,
        vorp: round(projection.projection - replacementProjection, 1),
        replacementProjection,
        scarcityGap: round(scarcityGap, 1),
        adpDelta: round(board.currentOverallPick - projection.adp, 1),
        rosterFit:
          userRosterId === null
            ? 50
            : scoreRosterFit(
                projection.position,
                userCounts,
                targets,
                board.currentRound,
                board.rounds,
              ),
        availableNextPickProbability: probabilityAvailableAtNextPick({
          adp: projection.adp,
          currentOverallPick: board.currentOverallPick,
          nextUserPick,
          interveningDemand,
          position: projection.position,
        }),
        tier: tierInfo.tier,
        playersRemainingInTier,
        gapAfterTier: tierInfo.gapAfterTier,
      },
    ];
  });

  const projectionScores = percentileScores(
    rawCandidates.map((candidate) => candidate.projection.projection),
  );
  const vorpScores = percentileScores(
    rawCandidates.map((candidate) => candidate.vorp),
  );
  const scarcityScores = percentileScores(
    rawCandidates.map((candidate) => candidate.scarcityGap),
  );
  const tierGapScores = percentileScores(
    rawCandidates.map((candidate) => candidate.gapAfterTier),
  );

  const recommendations = rawCandidates
    .map((candidate, index): DraftRecommendation => {
      const remainingTierScore =
        candidate.playersRemainingInTier <= 1
          ? 100
          : candidate.playersRemainingInTier === 2
            ? 76
            : candidate.playersRemainingInTier === 3
              ? 52
              : candidate.playersRemainingInTier === 4
                ? 32
                : 15;
      const components: DraftScoreComponents = {
        projection: projectionScores[index],
        vorp: vorpScores[index],
        scarcity: scarcityScores[index],
        tierUrgency: round(
          tierGapScores[index] * 0.65 + remainingTierScore * 0.35,
          1,
        ),
        rosterFit: candidate.rosterFit,
        adpValue: round(clamp(50 + candidate.adpDelta * 3), 1),
        nextPickRisk: round(100 - candidate.availableNextPickProbability, 1),
      };
      const score = scoreCandidate(components);
      const action =
        candidate.availableNextPickProbability <= 45 ||
        (components.tierUrgency >= 82 &&
          candidate.availableNextPickProbability < 60) ||
        (score >= 85 && candidate.availableNextPickProbability < 55)
          ? 'DRAFT_NOW'
          : 'WAIT';
      return {
        player: candidate.player,
        projection: candidate.projection,
        score,
        action,
        availableNextPickProbability: candidate.availableNextPickProbability,
        nextUserPick,
        picksUntilNextUserPick,
        tier: candidate.tier,
        playersRemainingInTier: candidate.playersRemainingInTier,
        components,
        raw: {
          vorp: candidate.vorp,
          scarcityGap: candidate.scarcityGap,
          adpDelta: candidate.adpDelta,
          replacementProjection: round(candidate.replacementProjection, 1),
        },
        reasons: buildReasons(candidate),
      };
    })
    .sort((a, b) => b.score - a.score || a.projection.rank - b.projection.rank);

  return {
    recommendations,
    nextUserPick,
    picksUntilNextUserPick,
    userDraftSlot,
    userRosterId,
  };
}
