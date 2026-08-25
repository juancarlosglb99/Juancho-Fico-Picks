import type { CanonicalPlayer, CanonicalPlayerMap, Position } from '../../players/types';
import type { AdpFormat, MappedProjection } from '../../projections/types';
import type { SleeperDraftPick, SleeperRoster } from '../../sleeper/types';
import { scoreProjectionForLeague, type ScoredProjection } from '../context/scoring';
import type { Confidence, LeagueContext, RosterConfiguration } from '../context/types';
import { clamp, percentileScores, round } from './math';
import { probabilityAvailableAtNextPick } from './next-pick-probability';
import {
  getRosterPositionCounts,
  getStarterTargets,
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
  context: LeagueContext;
  picks: SleeperDraftPick[];
  rosters: SleeperRoster[];
  board: DraftBoardState;
  players: CanonicalPlayerMap;
  projections: MappedProjection[];
}

interface ValuedProjection {
  source: MappedProjection;
  scored: MappedProjection;
  scoring: ScoredProjection;
}

interface RawCandidate {
  player: CanonicalPlayer;
  projection: MappedProjection;
  sourceProjection: MappedProjection;
  scoring: ScoredProjection;
  vorp: number;
  replacementProjection: number;
  replacementDemand: number;
  scarcityGap: number;
  adpDelta: number;
  rosterFit: number;
  availableNextPickProbability: number | null;
  nextPickConfidence: Confidence;
  tier: number;
  playersRemainingInTier: number;
  gapAfterTier: number;
}

const CORE_POSITIONS = new Set<Position>(['QB', 'RB', 'WR', 'TE']);

function starterDemand(position: Position, roster: RosterConfiguration): number {
  const flexDemand =
    position === 'RB'
      ? roster.FLEX * 0.44
      : position === 'WR'
        ? roster.FLEX * 0.46
        : position === 'TE'
          ? roster.FLEX * 0.1
          : 0;
  const superFlexDemand =
    position === 'QB'
      ? roster.SUPER_FLEX * 0.88
      : position === 'RB'
        ? roster.SUPER_FLEX * 0.04
        : position === 'WR'
          ? roster.SUPER_FLEX * 0.05
          : position === 'TE'
            ? roster.SUPER_FLEX * 0.03
            : 0;
  const direct =
    position === 'QB'
      ? roster.QB
      : position === 'RB'
        ? roster.RB
        : position === 'WR'
          ? roster.WR
          : position === 'TE'
            ? roster.TE
            : position === 'K'
              ? roster.K
              : position === 'DEF'
                ? roster.DEF
                : 0;
  return direct + flexDemand + superFlexDemand;
}

export function calculateReplacementDemand(
  position: Position,
  context: LeagueContext,
): number {
  const roster = context.roster.value;
  const teams = context.teams.value;
  const corePositions: Position[] = ['QB', 'RB', 'WR', 'TE'];
  const positionStarterDemand = starterDemand(position, roster);
  if (!CORE_POSITIONS.has(position)) {
    return Math.max(1, Math.ceil(positionStarterDemand * teams));
  }
  const totalCoreStarterDemand = corePositions.reduce(
    (sum, candidate) => sum + starterDemand(candidate, roster),
    0,
  );
  const benchUtilization = roster.SUPER_FLEX > 0 || roster.QB >= 2 ? 0.75 : 0.45;
  const positionShare =
    totalCoreStarterDemand > 0 ? positionStarterDemand / totalCoreStarterDemand : 0;
  const benchDemand = roster.bench * benchUtilization * positionShare;
  const perTeam = positionStarterDemand + benchDemand;
  const cappedPerTeam = position === 'QB' ? Math.min(2.5, perTeam) : perTeam;
  return Math.max(1, Math.ceil(cappedPerTeam * teams));
}

export function getReplacementProjections(
  projections: MappedProjection[],
  context: LeagueContext,
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
      calculateReplacementDemand(position, context) - 1,
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

function scoreCandidate(components: DraftScoreComponents): number {
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

function expectedAdpFormat(context: LeagueContext): AdpFormat {
  if (context.leagueType.value === 'dynasty') {
    return context.draftContext.value === 'rookie_supplemental'
      ? 'dynasty_rookie'
      : 'dynasty_startup';
  }
  return context.roster.value.SUPER_FLEX > 0 || context.roster.value.QB >= 2
    ? 'redraft_superflex'
    : 'redraft_1qb';
}

function nextPickConfidence(
  projection: MappedProjection,
  context: LeagueContext,
): Confidence {
  if (context.draftState.value.nextUserPick === null) return 'low';
  if (projection.adpFormat !== expectedAdpFormat(context)) return 'low';
  if (context.lineupType.value !== 'classic') return 'low';
  if (
    context.leagueType.value === 'keeper' ||
    context.teams.value !== 12 ||
    context.scoring.value.profile === 'custom' ||
    context.scoring.value.passing.touchdowns !== 4
  ) {
    return 'medium';
  }
  return 'high';
}

function confidenceWeight(confidence: Confidence): number {
  return confidence === 'high' ? 1 : confidence === 'medium' ? 0.6 : 0.25;
}

function scoringCoverage(
  valued: ValuedProjection[],
  context: LeagueContext,
): DraftRecommendationResult['scoringCoverage'] {
  const adjusted = valued.filter((item) => item.scoring.adjustedForLeagueScoring).length;
  if (adjusted === valued.length && valued.length > 0) return 'league_recalculated';
  if (adjusted > 0) return 'mixed';
  const expected = context.scoring.value.profile;
  const scoring = context.scoring.value;
  const receptionValues = Object.values(scoring.reception.byPosition);
  const usesBaselineScoring =
    expected !== 'unknown' &&
    expected !== 'custom' &&
    receptionValues.every((amount) => amount === scoring.reception.base) &&
    scoring.passing.yards === 0.04 &&
    scoring.passing.touchdowns === 4 &&
    scoring.passing.interceptions === -2 &&
    scoring.rushing.yards === 0.1 &&
    scoring.rushing.touchdowns === 6 &&
    scoring.receiving.yards === 0.1 &&
    scoring.receiving.touchdowns === 6 &&
    Object.keys(scoring.bonuses).length === 0;
  const verified =
    usesBaselineScoring &&
    valued.length > 0 &&
    valued.every(
      (item) =>
        item.source.projectionScoring?.trim().toLowerCase().replace(/[\s-]+/g, '_') ===
        expected,
    );
  return verified ? 'provider_precalculated' : 'aggregate_unverified';
}

function baseSupport(context: LeagueContext): {
  status: DraftRecommendationResult['status'];
  messages: string[];
} {
  const messages = [...context.warnings];
  if (context.leagueType.value === 'unknown') {
    return {
      status: 'data_required',
      messages: [
        ...messages,
        'Recommendations are paused until the league type is confirmed.',
      ],
    };
  }
  if (context.draftType.value === 'auction') {
    return {
      status: 'unsupported',
      messages: [
        ...messages,
        'Auction format detected. Snake-style next-pick and roster construction advice is disabled.',
      ],
    };
  }
  if (context.draftType.value === 'unknown') {
    return {
      status: 'unsupported',
      messages: [...messages, 'Sleeper returned an unsupported draft order.'],
    };
  }
  if (context.leagueType.value === 'dynasty') {
    const contextLabel =
      context.draftContext.value === 'rookie_supplemental'
        ? 'rookie/supplemental'
        : context.draftContext.value === 'startup'
          ? 'startup'
          : 'unresolved';
    return {
      status: 'data_required',
      messages: [
        ...messages,
        `Dynasty ${contextLabel} draft detected. Redraft projections are intentionally not used as dynasty values.`,
        'Import from a future DynastyValueProvider before dynasty recommendations are enabled.',
      ],
    };
  }
  if (context.lineupType.value === 'best_ball') {
    messages.push(
      'Best Ball detected. Roster-fit scoring is neutralized because weekly lineup assumptions do not apply.',
    );
  }
  if (context.lineupType.value === 'unknown') {
    messages.push(
      'Lineup type is unresolved. Roster-fit scoring is neutralized until Classic or Best Ball is confirmed.',
    );
  }
  if (context.leagueType.value === 'keeper') {
    messages.push(
      'Keeper advice is current-season only because keeper costs and escalation rules are not fully known.',
    );
  }
  return {
    status:
      context.lineupType.value !== 'classic' || context.leagueType.value === 'keeper'
        ? 'limited'
        : 'ready',
    messages,
  };
}

function buildReasons(candidate: RawCandidate): string[] {
  const reasons: string[] = [];
  if (candidate.availableNextPickProbability !== null) {
    const qualifier = candidate.nextPickConfidence === 'high' ? '' : 'Approx. ';
    reasons.push(
      `${qualifier}${Math.round(candidate.availableNextPickProbability)}% chance to make it back`,
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
    reasons.push(`${Math.round(candidate.adpDelta)} picks past imported ADP`);
  }
  return reasons.slice(0, 4);
}

function unavailableResult(
  context: LeagueContext,
  status: DraftRecommendationResult['status'],
  messages: string[],
): DraftRecommendationResult {
  return {
    recommendations: [],
    status,
    messages,
    scoringCoverage: 'aggregate_unverified',
    context,
    nextUserPick: context.draftState.value.nextUserPick,
    picksUntilNextUserPick: context.draftState.value.picksBeforeNextSelection,
    userDraftSlot: context.draftState.value.userDraftSlot,
    userRosterId: context.draftState.value.userRosterId,
  };
}

export function generateDraftRecommendations({
  context,
  picks,
  rosters,
  board,
  players,
  projections: inputProjections,
}: RecommendationInput): DraftRecommendationResult {
  const support = baseSupport(context);
  if (support.status === 'unsupported' || support.status === 'data_required') {
    return unavailableResult(context, support.status, support.messages);
  }

  const valued: ValuedProjection[] = uniqueProjectionRecords(inputProjections).map(
    (projection) => {
      const scoring = scoreProjectionForLeague(projection, context.scoring.value);
      return {
        source: projection,
        scored: { ...projection, projection: scoring.points },
        scoring,
      };
    },
  );
  const coverage = scoringCoverage(valued, context);
  let status = support.status;
  const messages = [...support.messages];
  if (coverage === 'aggregate_unverified') {
    status = 'limited';
    messages.push(
      'Imported fantasy points are aggregate and their scoring format is unverified; custom Sleeper scoring is not recalculated.',
    );
  } else if (coverage === 'mixed') {
    status = 'limited';
    messages.push('Only rows with complete stat lines were recalculated for league scoring.');
  }
  if (valued.some((item) => item.scoring.limitations.length > 0)) {
    status = 'limited';
    messages.push(...new Set(valued.flatMap((item) => item.scoring.limitations)));
  }
  if (context.roster.value.SUPER_FLEX > 0 || context.roster.value.QB >= 2) {
    const hasMatchingAdp = valued.some(
      (item) => item.source.adpFormat === 'redraft_superflex',
    );
    if (!hasMatchingAdp) {
      messages.push(
        'Superflex/2QB replacement demand is incorporated, but next-pick probability is approximate until Superflex ADP is imported.',
      );
    }
  }

  const availableIds = new Set(board.availablePlayers.map((player) => player.id));
  const allowKickersAndDefense = board.currentRound >= Math.max(1, board.rounds - 2);
  const candidates = valued.filter(
    ({ scored }) =>
      availableIds.has(scored.playerId) &&
      (CORE_POSITIONS.has(scored.position) ||
        (allowKickersAndDefense && ['K', 'DEF'].includes(scored.position))),
  );
  if (candidates.length === 0) {
    return {
      ...unavailableResult(context, status, messages),
      scoringCoverage: coverage,
    };
  }

  const scoredProjections = valued.map((item) => item.scored);
  const tiers = buildProjectionTiers(scoredProjections);
  const replacements = getReplacementProjections(scoredProjections, context);
  const targets = getStarterTargets(context.roster.value);
  const userRosterId = context.draftState.value.userRosterId;
  const userCounts =
    userRosterId === null
      ? {}
      : getRosterPositionCounts(userRosterId, picks, rosters, players);
  const rosterCounts = new Map(
    rosters.map((roster) => [
      roster.roster_id,
      getRosterPositionCounts(roster.roster_id, picks, rosters, players),
    ]),
  );

  const availableByPosition = new Map<Position, ValuedProjection[]>();
  for (const candidate of candidates) {
    availableByPosition.set(candidate.scored.position, [
      ...(availableByPosition.get(candidate.scored.position) ?? []),
      candidate,
    ]);
  }
  for (const [position, records] of availableByPosition) {
    availableByPosition.set(
      position,
      [...records].sort((a, b) => b.scored.projection - a.scored.projection),
    );
  }

  const rawCandidates: RawCandidate[] = candidates.flatMap((valuedProjection) => {
    const { scored: projection, source, scoring } = valuedProjection;
    const player = players.byId.get(projection.playerId);
    if (!player) return [];
    const tierInfo = tiers.get(projection.playerId) ?? {
      tier: 1,
      tierSize: 1,
      gapAfterTier: 0,
    };
    const positionPool = availableByPosition.get(projection.position) ?? [];
    const positionIndex = positionPool.findIndex(
      (record) => record.scored.playerId === projection.playerId,
    );
    const picksBeforeNext = context.draftState.value.interveningSelections.length;
    const lookahead = Math.max(1, Math.min(5, Math.ceil(picksBeforeNext / 3)));
    const nextAtPosition = positionPool[positionIndex + lookahead];
    const replacementProjection = replacements.get(projection.position) ?? projection.projection;
    const scarcityGap = Math.max(
      0,
      projection.projection -
        (nextAtPosition?.scored.projection ?? replacementProjection),
    );
    const playersRemainingInTier = positionPool.filter(
      (record) => tiers.get(record.scored.playerId)?.tier === tierInfo.tier,
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
    const interveningDemand = context.draftState.value.interveningSelections.reduce(
      (sum, selection) => {
        if (selection.ownerRosterId === null) return sum + 0.35;
        const count = rosterCounts.get(selection.ownerRosterId)?.[projection.position] ?? 0;
        return sum + (count < baseTarget ? 1 : 0.15);
      },
      0,
    );
    const confidence = nextPickConfidence(source, context);
    const nextUserPick = context.draftState.value.nextUserPick;
    const probability =
      nextUserPick === null
        ? null
        : probabilityAvailableAtNextPick({
            adp: source.adp,
            currentOverallPick: board.currentOverallPick,
            nextUserPick,
            interveningDemand,
            position: projection.position,
          });

    return [
      {
        player,
        projection,
        sourceProjection: source,
        scoring,
        vorp: round(projection.projection - replacementProjection, 1),
        replacementProjection,
        replacementDemand: calculateReplacementDemand(projection.position, context),
        scarcityGap: round(scarcityGap, 1),
        adpDelta: round(board.currentOverallPick - source.adp, 1),
        rosterFit:
          context.lineupType.value !== 'classic' || userRosterId === null
            ? 50
            : scoreRosterFit(
                projection.position,
                userCounts,
                targets,
                board.currentRound,
                board.rounds,
              ),
        availableNextPickProbability: probability,
        nextPickConfidence: confidence,
        tier: tierInfo.tier,
        playersRemainingInTier,
        gapAfterTier: tierInfo.gapAfterTier,
      },
    ];
  });

  const projectionScores = percentileScores(
    rawCandidates.map((candidate) => candidate.projection.projection),
  );
  const vorpScores = percentileScores(rawCandidates.map((candidate) => candidate.vorp));
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
      const rawNextPickRisk =
        candidate.availableNextPickProbability === null
          ? 50
          : 100 - candidate.availableNextPickProbability;
      const reliability = confidenceWeight(candidate.nextPickConfidence);
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
        nextPickRisk: round(50 + (rawNextPickRisk - 50) * reliability, 1),
      };
      const score = scoreCandidate(components);
      const probabilitySignal =
        candidate.nextPickConfidence !== 'low' &&
        candidate.availableNextPickProbability !== null &&
        candidate.availableNextPickProbability <= 45;
      const action =
        probabilitySignal ||
        components.tierUrgency >= 82 ||
        (score >= 85 && candidate.vorp > 0)
          ? 'DRAFT_NOW'
          : 'WAIT';
      return {
        player: candidate.player,
        projection: candidate.projection,
        score,
        action,
        availableNextPickProbability: candidate.availableNextPickProbability,
        nextPickConfidence: candidate.nextPickConfidence,
        nextUserPick: context.draftState.value.nextUserPick,
        picksUntilNextUserPick: context.draftState.value.picksBeforeNextSelection,
        tier: candidate.tier,
        playersRemainingInTier: candidate.playersRemainingInTier,
        components,
        raw: {
          projectedPoints: candidate.projection.projection,
          sourceProjectedPoints: candidate.sourceProjection.projection,
          vorp: candidate.vorp,
          scarcityGap: candidate.scarcityGap,
          adpDelta: candidate.adpDelta,
          replacementProjection: round(candidate.replacementProjection, 1),
          replacementDemand: candidate.replacementDemand,
          rosterNeed: candidate.rosterFit,
          scoringAdjusted: candidate.scoring.adjustedForLeagueScoring,
        },
        reasons: buildReasons(candidate),
      };
    })
    .sort((a, b) => b.score - a.score || a.projection.rank - b.projection.rank);

  return {
    recommendations,
    status,
    messages: [...new Set(messages)],
    scoringCoverage: coverage,
    context,
    nextUserPick: context.draftState.value.nextUserPick,
    picksUntilNextUserPick: context.draftState.value.picksBeforeNextSelection,
    userDraftSlot: context.draftState.value.userDraftSlot,
    userRosterId: context.draftState.value.userRosterId,
  };
}
