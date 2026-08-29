/**
 * Who may be selected in a draft happening now.
 *
 * This is a POLICY, not a definition, and the distinction is the whole point of
 * the file. "Sleeper places him on an NFL team" is the best rule available
 * against the data as it stands today - it is not what it MEANS to be an active
 * NFL player, and Sleeper is free to change how it maintains any of these
 * fields without telling us.
 *
 * So the rule is named, versioned and injectable. When it needs to change, the
 * change is a new policy and a new version rather than an edit to a condition
 * buried in a mapping function, and the regression corpus can pin the policy it
 * was captured under.
 *
 * What was ruled out, and why, from the August 2026 payload of 9,418 entries:
 *
 *   `active`  - `true` on every single entry, retired players included. It
 *               carries no information at all.
 *   `status`  - wrong in both directions. Tom Brady, Rob Gronkowski, Cam Newton
 *               and Antonio Brown are all `"Active"`; Adam Vinatieri, retired
 *               since 2019, is `"Injured Reserve"` - which is also the correct
 *               status for a current starter with a hamstring. Filtering on it
 *               drops real players and keeps retired ones.
 *   `team`    - maintained. 3,231 of the 9,418 carry one, which is the right
 *               order for 32 rosters plus practice squads, and every retired
 *               player checked carries null.
 *
 * The known cost is a genuinely unsigned free agent, who is excluded. That is
 * the right trade while it holds: no projection source and no ranking source
 * lists one, so he could not be evaluated even if he were offered.
 */
import type { SleeperPlayerRaw } from '../sleeper/types';

export interface EligibilityPolicy {
  /** Stable id, recorded alongside anything captured under this rule. */
  readonly id: string;
  /** What the rule is, in one line, for a diagnostics screen. */
  readonly describe: string;
  isDraftEligible(raw: SleeperPlayerRaw): boolean;
}

export const SLEEPER_TEAM_ASSIGNMENT: EligibilityPolicy = {
  id: 'sleeper-team-assignment-2026.1',
  describe: 'Sleeper currently places the player on an NFL team',
  isDraftEligible(raw) {
    return typeof raw.team === 'string' && raw.team.trim().length > 0;
  },
};

/**
 * Everybody, for tests and for replaying a board captured under an older rule.
 *
 * A saved draft contains whoever was actually selected, and reconstructing it
 * must not depend on today's eligibility opinion.
 */
export const ANY_KNOWN_PLAYER: EligibilityPolicy = {
  id: 'any-known-player',
  describe: 'Every player Sleeper has ever known',
  isDraftEligible: () => true,
};

/** The rule in force. Changing it is a deliberate act with a new version. */
export const CURRENT_ELIGIBILITY_POLICY = SLEEPER_TEAM_ASSIGNMENT;
