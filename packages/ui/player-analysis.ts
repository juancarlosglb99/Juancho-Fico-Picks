/**
 * Everything the player drawer draws, assembled once.
 *
 * The governing rule is that a chart appears only when the data behind it
 * exists. Fantasy tools routinely draw a smooth distribution from a single
 * expected value, or a "trend" from two points; the result looks like evidence
 * and contains none. So every section here is nullable, the components render
 * nothing for a null, and no number is manufactured to fill a panel.
 *
 * Everything is read from state the engine has already computed. The joint
 * questions call the same `jointOutcome` and `likelyBestAvailable` the
 * strategist's brief calls, over the same simulated runs, so the drawer and the
 * brief can never quote different numbers about the same pair.
 */
import { likelyBestAvailable } from '../engine/draft/joint-availability';
import type {
  DraftRecommendation,
  DraftRecommendationResult,
} from '../engine/draft/types';
import type { DraftBrief } from '../engine/strategist/types';
import type { Position } from '../players/types';
import type {
  AnalysisHeader,
  PeerComparison,
  PlayerAnalysis,
  ReplacementView,
  SurvivalView,
} from './player-analysis-types';
import {
  buildJoint,
  buildOpponentPressure,
  buildPlan,
  buildTierCliff,
} from './player-analysis-outlook';

export type * from './player-analysis-types';

/** How many same-position players the peer chart shows around the subject. */
const PEER_WINDOW = 9;

export function buildPlayerAnalysis({
  playerId,
  result,
  brief,
  draftedPlayerIds,
  teamNameFor,
}: {
  playerId: string;
  result: DraftRecommendationResult;
  /** Null when the strategist layer has nothing to say about this board. */
  brief: DraftBrief | null;
  draftedPlayerIds: Set<string>;
  /** Resolves a roster id to the name shown in the opponent-pressure chart. */
  teamNameFor?: (rosterId: number | null) => string | null;
}): PlayerAnalysis | null {
  const internals = result.internals;
  if (!internals) return null;
  const player = internals.playerOf(playerId);
  if (!player) return null;

  const engineRankIndex = result.recommendations.findIndex(
    (recommendation) => recommendation.player.id === playerId,
  );
  const shortlisted = engineRankIndex >= 0 ? result.recommendations[engineRankIndex] : null;
  const projection = internals.projectionOf(playerId) ?? null;
  const positionState = internals.rosterState.byPosition[player.position] ?? null;

  const header: AnalysisHeader = {
    playerId,
    name: player.name,
    position: player.position,
    team: player.team ?? null,
    age: player.age ?? null,
    yearsExperience: player.yearsExperience ?? null,
    status: notableStatus(player.status),
    firstSeedRank: internals.firstSeedOf(playerId)?.rank ?? null,
    firstSeedProjection: internals.sourceProjectionOf(playerId)?.projection ?? null,
    leagueProjection: projection?.projection ?? null,
    tier: internals.tierOf(playerId)?.tier ?? null,
    playersRemainingInTier: internals.playersRemainingInTier(playerId),
    juanchoRank: internals.juanchoBoardRankOf(playerId) ?? null,
    positionalRank: internals.positionalRankOf(playerId) ?? null,
    drafted: draftedPlayerIds.has(playerId),
    engineRank: engineRankIndex >= 0 ? engineRankIndex + 1 : null,
  };

  return {
    header,
    engineReasons: shortlisted?.reasons ?? [],
    need: positionState
      ? {
          level: positionState.depthNeed,
          openStartingSlots: positionState.openStartingSlots,
          drafted: positionState.drafted,
        }
      : null,
    dataWarning: internals.dataWarningOf(playerId) ?? null,
    peers: buildPeers(playerId, player.position, result),
    replacement: buildReplacement(playerId, player.position, result, shortlisted),
    survival: buildSurvival(playerId, result),
    tierCliff: buildTierCliff(playerId, player.position, result, brief),
    joint: buildJoint(playerId, result),
    opponentPressure: buildOpponentPressure(player.position, result, brief, teamNameFor),
    plan: buildPlan(playerId, player.name, result, brief),
  };
}

/** `Active` is every player's status and says nothing. Anything else does. */
function notableStatus(status: string | null | undefined): string | null {
  if (!status) return null;
  return status.trim().toLowerCase() === 'active' ? null : status;
}

/* ---------------------------------------------------------------- A. peers */

function buildPeers(
  playerId: string,
  position: Position,
  result: DraftRecommendationResult,
): PeerComparison | null {
  const internals = result.internals;
  if (!internals) return null;

  const atPosition = internals.candidatePool
    .filter((candidate) => candidate.position === position)
    .sort((a, b) => b.projection - a.projection);
  if (atPosition.length < 2) return null;

  const subjectIndex = atPosition.findIndex((candidate) => candidate.playerId === playerId);
  if (subjectIndex === -1) return null;

  // A window centred on the subject, pulled back inside the list at either end.
  const half = Math.floor(PEER_WINDOW / 2);
  const start = Math.max(0, Math.min(subjectIndex - half, atPosition.length - PEER_WINDOW));
  const window = atPosition.slice(Math.max(0, start), Math.max(0, start) + PEER_WINDOW);

  return {
    position,
    subjectIndex: subjectIndex + 1,
    totalAtPosition: atPosition.length,
    bars: window.map((candidate) => ({
      playerId: candidate.playerId,
      name: internals.playerOf(candidate.playerId)?.name ?? candidate.playerId,
      projectedPoints: candidate.projection,
      firstSeedRank: internals.firstSeedOf(candidate.playerId)?.rank ?? null,
      tier: internals.tierOf(candidate.playerId)?.tier ?? null,
      isSubject: candidate.playerId === playerId,
    })),
  };
}

/* ---------------------------------------------------------- B. replacement */

function buildReplacement(
  playerId: string,
  position: Position,
  result: DraftRecommendationResult,
  shortlisted: DraftRecommendation | null,
): ReplacementView | null {
  const internals = result.internals;
  if (!internals) return null;
  const subject = internals.candidatePool.find((candidate) => candidate.playerId === playerId);
  if (!subject) return null;

  const outcomes = internals.roomOutcomes;
  const likely = outcomes
    ? likelyBestAvailable(outcomes, { limit: 3, position }).filter(
        (entry) => entry.playerId !== playerId,
      )
    : [];
  const best = likely[0] ?? null;
  const replacementCandidate = best
    ? internals.candidatePool.find((candidate) => candidate.playerId === best.playerId) ?? null
    : null;

  /*
   * Roster gain is what the pick is worth to THIS roster, and only the
   * candidates the engine actually planned have one. Reporting a raw projection
   * where a gain is expected would put a quarterback's four hundred points
   * beside a running back's fifty-point lineup contribution as though they
   * measured the same thing.
   */
  const gainOf = (id: string): number | null => {
    const planned = internals.plannedOf(id);
    if (!planned) return null;
    return Math.round((planned.immediate - internals.currentRosterValue) * 10) / 10;
  };

  const subjectGain = gainOf(playerId);
  const replacementGain = replacementCandidate ? gainOf(replacementCandidate.playerId) : null;

  return {
    subject: {
      name: internals.playerOf(playerId)?.name ?? playerId,
      projectedPoints: subject.projection,
      rosterGain: subjectGain,
    },
    replacement:
      replacementCandidate && best
        ? {
            playerId: replacementCandidate.playerId,
            name: internals.playerOf(replacementCandidate.playerId)?.name ?? best.playerId,
            projectedPoints: replacementCandidate.projection,
            rosterGain: replacementGain,
            chanceBestOfPosition: best.frequency,
          }
        : null,
    replacementLevel: shortlisted?.raw.replacementProjection ?? null,
    pointsDelta: replacementCandidate
      ? Math.round((subject.projection - replacementCandidate.projection) * 10) / 10
      : null,
    rosterValueDelta:
      subjectGain !== null && replacementGain !== null
        ? Math.round((subjectGain - replacementGain) * 10) / 10
        : null,
    caveat:
      !outcomes
        ? 'The room simulation did not run for this board, so the likely replacement is unknown.'
        : !replacementCandidate
          ? 'No other player at this position appears as the best available in any simulated future.'
          : subjectGain === null || replacementGain === null
            ? 'Roster value is only computed for the candidates the engine planned, so one side of this comparison shows raw points only.'
            : null,
  };
}

/* -------------------------------------------------------------- C. survival */

function buildSurvival(
  playerId: string,
  result: DraftRecommendationResult,
): SurvivalView | null {
  const internals = result.internals;
  if (!internals) return null;
  const estimate = internals.survivalOf(playerId);
  if (estimate.value === null || !estimate.modeled) return null;

  return {
    probability: estimate.value,
    confidence: estimate.confidence,
    interveningSelections: result.picksUntilNextUserPick ?? 0,
    teamsWithNeed: estimate.teamsWithNeed,
    demand: estimate.demand,
    runs: internals.roomOutcomes?.runs ?? null,
  };
}

