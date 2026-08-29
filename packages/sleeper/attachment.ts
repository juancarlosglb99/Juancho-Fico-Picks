/**
 * Attaching to any Sleeper draft, with or without a league behind it.
 *
 * A Sleeper mock draft has `league_id === null`. It has no league object, no
 * rosters and no owners - only the draft, its settings, and `draft_order`.
 * The recommendation engine, however, is built around a normalized
 * `LeagueContext` derived from a `SleeperLeague` plus `SleeperRoster[]`.
 *
 * Rather than fork the engine for mocks, this module synthesizes the missing
 * pieces FROM THE DRAFT ITSELF, so a mock and a real league draft travel the
 * exact same code path. Everything inferred is recorded in `inferredNotes` so
 * the UI can say plainly which parts came from the draft room rather than from
 * a real league.
 *
 * Pure functions: no network, no DOM.
 */
import type {
  SleeperDraft,
  SleeperLeague,
  SleeperLeagueStatus,
  SleeperRoster,
} from './types';

export type DraftAttachmentSource = 'league' | 'mock';

export interface DraftAttachment {
  draft: SleeperDraft;
  /** The real league, or one synthesized from the draft for a mock. */
  league: SleeperLeague;
  /** Real rosters, or one synthetic roster per draft slot for a mock. */
  rosters: SleeperRoster[];
  source: DraftAttachmentSource;
  /** True when `league` and `rosters` were derived from the draft alone. */
  synthesized: boolean;
  /** Short human label for the attach banner, e.g. "Mock draft · 12 team PPR". */
  label: string;
  /** Plain-English list of anything we inferred rather than read. */
  inferredNotes: string[];
}

/** Sleeper mock drafts are exactly the drafts with no league behind them. */
export function isMockDraft(draft: SleeperDraft): boolean {
  return !draft.league_id;
}

/**
 * Sleeper's default NFL scoring, which is what a mock draft room uses.
 * Only the reception value changes between the standard/half/full variants.
 */
function scoringSettingsFor(receptionPoints: number): Record<string, number> {
  return {
    pass_yd: 0.04,
    pass_td: 4,
    pass_int: -2,
    rush_yd: 0.1,
    rush_td: 6,
    rec: receptionPoints,
    rec_yd: 0.1,
    rec_td: 6,
    fum_lost: -2,
  };
}

/** `ppr` -> 1, `half_ppr` -> 0.5, anything else -> 0. */
export function receptionPointsForScoringType(scoringType: string | undefined): number {
  const value = (scoringType ?? '').toLowerCase();
  if (value.includes('half')) return 0.5;
  if (value.includes('ppr')) return 1;
  return 0;
}

export function scoringLabelFor(scoringType: string | undefined): string {
  const points = receptionPointsForScoringType(scoringType);
  if (points === 1) return 'PPR';
  if (points === 0.5) return 'Half-PPR';
  return 'Standard';
}

function leagueStatusForDraft(status: SleeperDraft['status']): SleeperLeagueStatus {
  if (status === 'complete') return 'in_season';
  if (status === 'pre_draft') return 'pre_draft';
  return 'drafting';
}

/** `dynasty` / `keeper` in the draft metadata, otherwise a plain redraft. */
function leagueTypeCodeFor(draft: SleeperDraft): number {
  const raw = (draft.metadata.league_type ?? '').toLowerCase();
  if (raw.includes('dynasty')) return 2;
  if (raw.includes('keeper')) return 1;
  return 0;
}

/**
 * Build the league object a mock draft never had.
 *
 * `roster_positions` is deliberately left EMPTY. The context normalizer already
 * falls back to `draft.settings.slots_*` when a league exposes no roster
 * positions, and it labels that source honestly as `draft.settings` with medium
 * confidence. Fabricating a roster_positions array would launder an inference
 * into something the engine reports as high-confidence league data.
 */
export function synthesizeLeagueForDraft(draft: SleeperDraft): SleeperLeague {
  const scoringType = draft.metadata.scoring_type;
  const teams = draft.settings.teams ?? 12;

  return {
    league_id: `mock:${draft.draft_id}`,
    name: draft.metadata.name?.trim() || 'Sleeper mock draft',
    season: draft.season,
    status: leagueStatusForDraft(draft.status),
    total_rosters: teams,
    draft_id: draft.draft_id,
    avatar: null,
    scoring_settings: scoringSettingsFor(receptionPointsForScoringType(scoringType)),
    roster_positions: [],
    settings: {
      type: leagueTypeCodeFor(draft),
      // A mock draft room is a classic starting-lineup draft, never best ball.
      best_ball: 0,
      num_teams: teams,
    },
    metadata: null,
  };
}

/**
 * One roster per draft slot, owned by whoever holds that slot in `draft_order`.
 *
 * `players` stays null on purpose: in a mock, everything a team owns came from a
 * pick, and the board already derives ownership from the pick list.
 */
export function synthesizeRostersForDraft(draft: SleeperDraft): SleeperRoster[] {
  const teams = draft.settings.teams ?? 12;
  const slotToRosterId = draft.slot_to_roster_id ?? {};

  const ownerBySlot = new Map<number, string>();
  for (const [userId, slot] of Object.entries(draft.draft_order ?? {})) {
    ownerBySlot.set(Number(slot), userId);
  }

  const rosters: SleeperRoster[] = [];
  for (let slot = 1; slot <= teams; slot += 1) {
    rosters.push({
      roster_id: Number(slotToRosterId[String(slot)] ?? slot),
      owner_id: ownerBySlot.get(slot) ?? null,
      players: null,
      starters: null,
      reserve: null,
      settings: null,
    });
  }
  return rosters;
}

/** A compact description of what we are attached to, for the banner. */
export function describeDraftAttachment(
  draft: SleeperDraft,
  source: DraftAttachmentSource,
): string {
  const teams = draft.settings.teams ?? 12;
  const scoring = scoringLabelFor(draft.metadata.scoring_type);
  const shape =
    draft.settings.reversal_round === 3 && draft.type === 'snake'
      ? '3RR'
      : draft.type;
  const kind = source === 'mock' ? 'Mock draft' : draft.metadata.name?.trim() || 'League draft';
  const superflex = (draft.settings.slots_super_flex ?? 0) > 0 ? ' Superflex' : '';
  return `${kind} · ${teams} team ${scoring}${superflex} ${shape}`;
}

export interface BuildDraftAttachmentInput {
  draft: SleeperDraft;
  /** The real league, when the draft belongs to one. */
  league?: SleeperLeague | null;
  /** The real rosters, when the draft belongs to a league. */
  rosters?: SleeperRoster[] | null;
}

/**
 * Produce a uniform attachment for either kind of draft. Callers downstream of
 * this function do not need to know whether they are in a mock or a real league.
 */
export function buildDraftAttachment({
  draft,
  league,
  rosters,
}: BuildDraftAttachmentInput): DraftAttachment {
  const hasLeague = Boolean(league) && !isMockDraft(draft);

  if (hasLeague && league) {
    return {
      draft,
      league,
      rosters: rosters ?? [],
      source: 'league',
      synthesized: false,
      label: describeDraftAttachment(draft, 'league'),
      inferredNotes: [],
    };
  }

  const inferredNotes = [
    'This draft has no Sleeper league behind it, so roster slots and scoring were read from the draft room settings.',
  ];
  if (!draft.metadata.scoring_type) {
    inferredNotes.push(
      'The draft room did not report a scoring type, so standard (non-PPR) scoring was assumed.',
    );
  }
  if (!draft.draft_order) {
    inferredNotes.push(
      'The draft room has not published its draft order yet, so your seat cannot be identified until it does.',
    );
  }

  return {
    draft,
    league: synthesizeLeagueForDraft(draft),
    rosters: synthesizeRostersForDraft(draft),
    source: 'mock',
    synthesized: true,
    label: describeDraftAttachment(draft, 'mock'),
    inferredNotes,
  };
}
