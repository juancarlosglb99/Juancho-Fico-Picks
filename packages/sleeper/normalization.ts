import type {
  LeagueRosterView,
  SleeperLeagueUser,
  SleeperRoster,
} from './types';

export function joinRostersWithOwners(
  rosters: SleeperRoster[],
  users: SleeperLeagueUser[],
): LeagueRosterView[] {
  const ownersById = new Map(users.map((user) => [user.user_id, user]));

  return [...rosters]
    .sort((a, b) => a.roster_id - b.roster_id)
    .map((roster) => {
      const owner = roster.owner_id ? ownersById.get(roster.owner_id) ?? null : null;
      const displayName =
        owner?.display_name || owner?.username || `Roster ${roster.roster_id}`;
      return {
        roster,
        owner,
        displayName,
        teamName: owner?.metadata?.team_name || displayName,
      };
    });
}

export function formatRosterPositions(positions: string[]): string {
  const counts = new Map<string, number>();
  for (const position of positions) {
    if (position === 'BN') continue;
    counts.set(position, (counts.get(position) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([position, count]) => `${count} ${position}`)
    .join(' · ');
}

export function getScoringLabel(scoring: Record<string, number>): string {
  const receptions = scoring.rec ?? 0;
  if (receptions >= 1) return 'PPR';
  if (receptions >= 0.5) return 'Half PPR';
  return 'Standard';
}
