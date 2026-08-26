/**
 * Drafting by First Seed's board alone, as the control group.
 *
 * The whole justification for a strategy engine is that it beats simply taking
 * the best player on the published board. That is a claim, and this is how it
 * gets tested: same saved draft, same seat, same room, same data - one seat
 * driven by First Seed's rank and nothing else, the other by Juancho.
 *
 * If Juancho cannot beat this, its deviations are not insight, and it should
 * defer to the board instead of inventing its own.
 */
import type { DraftRoomRankingSnapshot, ProjectionSnapshot } from '../../data/types';
import type { CanonicalPlayerMap, Position } from '../../players/types';
import type { SleeperDraft, SleeperLeague, SleeperRoster } from '../../sleeper/types';
import { normalizeLeagueContext } from '../context/normalize';
import { deriveDraftBoardState } from '../draft/state';
import { lineupSlotsFor, type LineupPlayer, type LineupSlots } from '../draft/lineup';
import type { RegressionCase } from './case';
import { scoreRoster, type RosterQuality } from './quality';

export interface FirstSeedBaselineInput {
  regression: RegressionCase;
  projections: ProjectionSnapshot;
  roomRankings: DraftRoomRankingSnapshot | null;
  players: CanonicalPlayerMap;
  league: SleeperLeague;
  draft: SleeperDraft;
  rosters: SleeperRoster[];
  /**
   * Whether the baseline is allowed to fill required kicker and defense slots
   * in the closing rounds.
   *
   * First Seed does not rank them, so a purist baseline finishes with an
   * illegal lineup and a large penalty that says more about the sheet than
   * about the strategy. Both variants are reported.
   */
  fillRequiredSlots?: boolean;
}

export interface BaselineResult {
  roster: { name: string; position: Position; round: number }[];
  quality: RosterQuality;
}

/**
 * Replays a saved draft with our seat taking the best available First Seed rank
 * every time.
 *
 * The room's real picks are kept exactly as they happened, so both strategies
 * face the identical board.
 */
export function draftByFirstSeedOnly(input: FirstSeedBaselineInput): BaselineResult {
  const {
    regression,
    projections,
    roomRankings,
    players,
    league,
    draft,
    rosters,
    fillRequiredSlots = true,
  } = input;

  const ordered = [...regression.picks].sort((a, b) => a.pick_no - b.pick_no);
  const ourPickNumbers = ordered
    .filter((pick) => pick.draft_slot === regression.userSlot)
    .map((pick) => pick.pick_no);

  const projectionById = new Map(projections.records.map((r) => [r.playerId, r]));
  const rankById = new Map((roomRankings?.records ?? []).map((r) => [r.playerId, r.rank]));

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

  const ourRoster: LineupPlayer[] = [];
  const takenByUs: string[] = [];
  const roster: { name: string; position: Position; round: number }[] = [];

  for (const overallPick of ourPickNumbers) {
    const roomBefore = ordered.filter(
      (pick) => pick.pick_no < overallPick && pick.draft_slot !== regression.userSlot,
    );
    const oursBefore = ordered
      .filter((pick) => pick.draft_slot === regression.userSlot && pick.pick_no < overallPick)
      .map((pick, index) => ({ ...pick, player_id: takenByUs[index] ?? pick.player_id }));
    const picksBefore = [...roomBefore, ...oursBefore].sort((a, b) => a.pick_no - b.pick_no);
    const board = deriveDraftBoardState(draft, picksBefore, rosters, players);
    const round = ordered.find((pick) => pick.pick_no === overallPick)!.round;
    const roundsLeft = regression.format.rounds - round;

    let chosen = bestByFirstSeed(board.availablePlayers, rankById, projectionById);

    // Closing rounds: take the kicker and defense the lineup requires, because
    // First Seed never ranks them and the seat would otherwise field an illegal
    // lineup for reasons that have nothing to do with strategy.
    if (fillRequiredSlots) {
      const required = missingRequiredSlot(ourRoster, slots);
      if (required && roundsLeft < 2) {
        const filler = board.availablePlayers.find((p) => p.position === required);
        if (filler) chosen = filler.id;
      }
    }
    if (!chosen) continue;

    const player = players.byId.get(chosen);
    const sleeperId = player?.externalIds.sleeper;
    if (!player || !sleeperId) continue;
    takenByUs.push(sleeperId);
    ourRoster.push({
      playerId: player.id,
      position: player.position,
      projection: projectionById.get(player.id)?.projection ?? nominalFor(player.position),
    });
    roster.push({ name: player.name, position: player.position, round });
  }

  return { roster, quality: scoreRoster(ourRoster, slots) };
}

function bestByFirstSeed(
  available: { id: string }[],
  rankById: Map<string, number>,
  projectionById: Map<string, unknown>,
): string | null {
  let bestId: string | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const player of available) {
    const rank = rankById.get(player.id);
    if (rank === undefined) continue;
    // A ranked player with no projection cannot be scored either way; skipping
    // him keeps the two strategies comparable.
    if (!projectionById.has(player.id)) continue;
    if (rank < bestRank) {
      bestRank = rank;
      bestId = player.id;
    }
  }
  return bestId;
}

function missingRequiredSlot(
  roster: LineupPlayer[],
  slots: LineupSlots,
): Position | null {
  const held = (position: Position) =>
    roster.filter((player) => player.position === position).length;
  if (slots.K > 0 && held('K') < slots.K) return 'K';
  if (slots.DEF > 0 && held('DEF') < slots.DEF) return 'DEF';
  return null;
}

/** Matches the engine's stand-in values so the comparison stays fair. */
function nominalFor(position: Position): number {
  if (position === 'K') return 125;
  if (position === 'DEF') return 115;
  return 0;
}
