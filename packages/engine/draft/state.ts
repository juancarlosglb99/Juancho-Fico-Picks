import type { CanonicalPlayerMap } from '../../players/types';
import type {
  SleeperDraft,
  SleeperDraftPick,
  SleeperRoster,
} from '../../sleeper/types';
import type { DraftBoardState } from './types';

const DRAFTABLE_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF']);

export function deriveDraftBoardState(
  draft: SleeperDraft,
  picks: SleeperDraftPick[],
  rosters: SleeperRoster[],
  playerMap: CanonicalPlayerMap,
): DraftBoardState {
  const teams = Math.max(1, draft.settings.teams ?? rosters.length ?? 1);
  const rounds = Math.max(1, draft.settings.rounds ?? 1);
  const draftedSleeperIds = new Set(picks.map((pick) => pick.player_id));
  const unavailableSleeperIds = new Set(draftedSleeperIds);

  for (const roster of rosters) {
    for (const sleeperId of roster.players ?? []) {
      unavailableSleeperIds.add(sleeperId);
    }
  }

  const picksMade = picks.length;
  const currentOverallPick = picksMade + 1;
  const currentRound = Math.min(rounds, Math.ceil(currentOverallPick / teams));
  const pickInRound = ((currentOverallPick - 1) % teams) + 1;
  const availablePlayers = playerMap.players.filter(
    (player) =>
      player.externalIds.sleeper &&
      !unavailableSleeperIds.has(player.externalIds.sleeper) &&
      DRAFTABLE_POSITIONS.has(player.position),
  );

  return {
    teams,
    rounds,
    picksMade,
    currentOverallPick,
    currentRound,
    pickInRound,
    draftedSleeperIds,
    unavailableSleeperIds,
    availablePlayers,
  };
}
