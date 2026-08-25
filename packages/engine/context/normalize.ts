import type {
  SleeperDraft,
  SleeperDraftPick,
  SleeperLeague,
  SleeperRoster,
  SleeperTradedPick,
} from '../../sleeper/types';
import type { DraftBoardState } from '../draft/types';
import {
  findNextUserSelection,
  slotForOverallPick,
  type NormalizedDraftType,
} from '../draft/next-pick-probability';
import type {
  Confidence,
  ContextValue,
  DraftContext,
  DraftSelectionContext,
  KeeperSettings,
  LeagueContext,
  LeagueContextOverrides,
  LeagueType,
  LineupType,
  NormalizedDraftState,
  NormalizedScoring,
  RosterConfiguration,
  ScoringProfile,
} from './types';

interface NormalizeLeagueContextInput {
  league: SleeperLeague;
  draft: SleeperDraft;
  drafts: SleeperDraft[];
  picks: SleeperDraftPick[];
  tradedPicks: SleeperTradedPick[];
  rosters: SleeperRoster[];
  board: DraftBoardState;
  userId: string;
  overrides?: LeagueContextOverrides;
}

function value<T>(item: T, source: string, confidence: Confidence): ContextValue<T> {
  return { value: item, source, confidence };
}

function rounded(input: number | undefined, fallback: number): number {
  if (input === undefined || !Number.isFinite(input)) return fallback;
  return Math.round(input * 1000) / 1000;
}

function detectedLeagueType(league: SleeperLeague): ContextValue<LeagueType> {
  const raw = league.settings.type;
  if (raw === 0) return value('redraft', 'league.settings.type', 'high');
  if (raw === 1) return value('keeper', 'league.settings.type', 'high');
  if (raw === 2) return value('dynasty', 'league.settings.type', 'high');
  return value('unknown', 'league.settings.type', 'low');
}

function detectedDraftType(draft: SleeperDraft): ContextValue<NormalizedDraftType> {
  if (draft.type === 'snake' && draft.settings.reversal_round === 3) {
    return value('3rr', 'draft.type + draft.settings.reversal_round', 'high');
  }
  if (draft.type === 'snake' || draft.type === 'linear' || draft.type === 'auction') {
    return value(draft.type, 'draft.type', 'high');
  }
  return value('unknown', 'draft.type', 'low');
}

function detectedLineupType(league: SleeperLeague): ContextValue<LineupType> {
  if (league.settings.best_ball === 1) {
    return value('best_ball', 'league.settings.best_ball', 'high');
  }
  if (league.settings.best_ball === 0) {
    return value('classic', 'league.settings.best_ball', 'high');
  }
  return value('unknown', 'league.settings.best_ball', 'low');
}

function countRosterPositions(positions: string[]) {
  const counts = new Map<string, number>();
  for (const rawPosition of positions) {
    const position = rawPosition.toUpperCase();
    counts.set(position, (counts.get(position) ?? 0) + 1);
  }
  return counts;
}

function normalizeRoster(
  league: SleeperLeague,
  draft: SleeperDraft,
): ContextValue<RosterConfiguration> {
  const counts = countRosterPositions(league.roster_positions ?? []);
  const take = (...positions: string[]) =>
    positions.reduce((sum, position) => sum + (counts.get(position) ?? 0), 0);
  const idpKeys = ['DL', 'DE', 'DT', 'LB', 'DB', 'CB', 'S', 'IDP_FLEX'];
  const known = new Set([
    'QB',
    'RB',
    'WR',
    'TE',
    'FLEX',
    'WRRB_FLEX',
    'RB_WR',
    'REC_FLEX',
    'WRT_FLEX',
    'SUPER_FLEX',
    'K',
    'DEF',
    'DST',
    'BN',
    'TAXI',
    'IR',
    ...idpKeys,
  ]);
  const idp = Object.fromEntries(
    idpKeys.filter((position) => counts.has(position)).map((position) => [position, counts.get(position)!]),
  );
  const unknown = Object.fromEntries(
    [...counts.entries()].filter(([position]) => !known.has(position)),
  );
  const fromLeague = league.roster_positions.length > 0;
  const roster: RosterConfiguration = {
    QB: take('QB') || draft.settings.slots_qb || 0,
    RB: take('RB') || draft.settings.slots_rb || 0,
    WR: take('WR') || draft.settings.slots_wr || 0,
    TE: take('TE') || draft.settings.slots_te || 0,
    FLEX:
      take('FLEX', 'WRRB_FLEX', 'RB_WR', 'REC_FLEX', 'WRT_FLEX') ||
      draft.settings.slots_flex ||
      draft.settings.slots_wrrb_flex ||
      0,
    SUPER_FLEX: take('SUPER_FLEX') || draft.settings.slots_super_flex || 0,
    K: take('K') || draft.settings.slots_k || 0,
    DEF: take('DEF', 'DST') || draft.settings.slots_def || 0,
    bench: take('BN') || draft.settings.slots_bn || 0,
    taxi: Math.max(take('TAXI'), league.settings.taxi_slots ?? 0),
    IR: Math.max(take('IR'), league.settings.reserve_slots ?? 0),
    idp,
    unknown,
    totalStarterSpots: 0,
  };
  roster.totalStarterSpots =
    roster.QB +
    roster.RB +
    roster.WR +
    roster.TE +
    roster.FLEX +
    roster.SUPER_FLEX +
    roster.K +
    roster.DEF +
    Object.values(roster.idp).reduce((sum, count) => sum + count, 0);
  return value(
    roster,
    fromLeague ? 'league.roster_positions + league.settings' : 'draft.settings',
    fromLeague ? 'high' : 'medium',
  );
}

function scoringProfile(receptions: Record<'RB' | 'WR' | 'TE', number>): ScoringProfile {
  const values = Object.values(receptions);
  if (values.every((item) => item === 0)) return 'standard';
  if (values.every((item) => item === 0.5)) return 'half_ppr';
  if (values.every((item) => item === 1)) return 'full_ppr';
  return 'custom';
}

function normalizeScoring(league: SleeperLeague): ContextValue<NormalizedScoring> {
  const settings = league.scoring_settings ?? {};
  const base = rounded(settings.rec, 0);
  const reception = {
    RB: base + rounded(settings.bonus_rec_rb ?? settings.rec_rb, 0),
    WR: base + rounded(settings.bonus_rec_wr ?? settings.rec_wr, 0),
    TE: base + rounded(settings.bonus_rec_te ?? settings.rec_te, 0),
  };
  const directlySupported = new Set([
    'rec',
    'bonus_rec_rb',
    'bonus_rec_wr',
    'bonus_rec_te',
    'rec_rb',
    'rec_wr',
    'rec_te',
    'pass_yd',
    'pass_td',
    'pass_int',
    'rush_yd',
    'rush_td',
    'rec_yd',
    'rec_td',
    'fum_lost',
  ]);
  const bonuses = Object.fromEntries(
    Object.entries(settings).filter(
      ([key, amount]) =>
        amount !== 0 &&
        !directlySupported.has(key) &&
        (key.startsWith('pass_') ||
          key.startsWith('rush_') ||
          key.startsWith('rec_') ||
          key.startsWith('bonus_') ||
          key.startsWith('fum')),
    ),
  );
  return value(
    {
      settings: { ...settings },
      profile: league.scoring_settings ? scoringProfile(reception) : 'unknown',
      reception: { base, byPosition: reception },
      passing: {
        yards: rounded(settings.pass_yd, 0.04),
        touchdowns: rounded(settings.pass_td, 4),
        interceptions: rounded(settings.pass_int, -2),
      },
      rushing: {
        yards: rounded(settings.rush_yd, 0.1),
        touchdowns: rounded(settings.rush_td, 6),
      },
      receiving: {
        yards: rounded(settings.rec_yd, 0.1),
        touchdowns: rounded(settings.rec_td, 6),
      },
      tePremium: Math.max(0, rounded(settings.bonus_rec_te ?? settings.rec_te, 0)),
      bonuses,
    },
    league.scoring_settings ? 'league.scoring_settings' : 'default NFL scoring fallbacks',
    league.scoring_settings ? 'high' : 'low',
  );
}

function detectDraftContext(
  leagueType: LeagueType,
  draft: SleeperDraft,
  drafts: SleeperDraft[],
  rosters: SleeperRoster[],
): ContextValue<DraftContext> {
  if (leagueType === 'redraft' || leagueType === 'keeper') {
    return value('veteran_all_player', 'league type', 'high');
  }
  if (leagueType !== 'dynasty') return value('unknown', 'insufficient Sleeper data', 'low');

  const text = `${draft.metadata.name ?? ''} ${draft.metadata.description ?? ''}`.toLowerCase();
  if (/rookie|supplemental/.test(text)) {
    return value('rookie_supplemental', 'draft.metadata name/description', 'high');
  }
  if (/startup|start-up/.test(text)) {
    return value('startup', 'draft.metadata name/description', 'high');
  }
  if (/veteran|all[- ]?player/.test(text)) {
    return value('veteran_all_player', 'draft.metadata name/description', 'high');
  }

  const rosteredPlayers = rosters.reduce((sum, roster) => sum + (roster.players?.length ?? 0), 0);
  if (rosteredPlayers === 0 && (draft.settings.rounds ?? 0) > 10) {
    return value('startup', 'empty rosters + full-length draft', 'medium');
  }
  if (rosteredPlayers > 0 && draft.settings.player_type === 0 && (draft.settings.rounds ?? 0) <= 10) {
    return value(
      'rookie_supplemental',
      'populated rosters + draft.settings.player_type + short draft',
      'medium',
    );
  }
  if (rosteredPlayers > 0 && drafts.length > 1 && (draft.settings.rounds ?? 0) <= 10) {
    return value(
      'rookie_supplemental',
      'multiple league drafts + populated rosters + short draft',
      'medium',
    );
  }
  return value('unknown', 'insufficient Sleeper draft metadata', 'low');
}

function normalizeKeeperSettings(
  leagueType: LeagueType,
  league: SleeperLeague,
): ContextValue<KeeperSettings> {
  const numberOfKeepers =
    typeof league.settings.max_keepers === 'number' ? league.settings.max_keepers : null;
  return value(
    {
      detected: leagueType === 'keeper',
      rulesFullyKnown: false,
      numberOfKeepers,
      acquisitionCost: null,
      roundPenalty: null,
      maxYearsRetained: null,
      escalatingCost: null,
      auctionKeeperPrice: null,
      otherRules: null,
    },
    numberOfKeepers === null
      ? 'league.settings.type; keeper economics unavailable'
      : 'league.settings.type + league.settings.max_keepers',
    leagueType === 'keeper' ? 'medium' : 'high',
  );
}

function resolveUserRosterId(rosters: SleeperRoster[], userId: string): number | null {
  return rosters.find((roster) => roster.owner_id === userId)?.roster_id ?? null;
}

function resolveUserSlot(
  draft: SleeperDraft,
  picks: SleeperDraftPick[],
  userId: string,
  userRosterId: number | null,
): number | null {
  if (draft.draft_order?.[userId]) return draft.draft_order[userId];
  if (userRosterId !== null) {
    const entry = Object.entries(draft.slot_to_roster_id ?? {}).find(
      ([, rosterId]) => Number(rosterId) === userRosterId,
    );
    if (entry) return Number(entry[0]);
    return picks.find((pick) => Number(pick.roster_id) === userRosterId)?.draft_slot ?? null;
  }
  return null;
}

function selectionOwner(
  overallPick: number,
  teams: number,
  draftType: NormalizedDraftType,
  slotToRosterId: Record<string, number>,
  tradedPicks: SleeperTradedPick[],
): DraftSelectionContext {
  const draftSlot = slotForOverallPick(overallPick, teams, draftType);
  const round = Math.ceil(overallPick / teams);
  const originalRosterId = slotToRosterId[String(draftSlot)] ?? null;
  const trade = tradedPicks.find(
    (candidate) => candidate.round === round && candidate.roster_id === originalRosterId,
  );
  return {
    overallPick,
    round,
    draftSlot,
    originalRosterId,
    ownerRosterId: trade?.owner_id ?? originalRosterId,
  };
}

function normalizeDraftState(
  input: NormalizeLeagueContextInput,
  draftType: NormalizedDraftType,
): ContextValue<NormalizedDraftState> {
  const { draft, picks, tradedPicks, rosters, board, userId } = input;
  const userRosterId = resolveUserRosterId(rosters, userId);
  const userDraftSlot = resolveUserSlot(draft, picks, userId, userRosterId);
  const slotToRosterId = Object.fromEntries(
    Object.entries(draft.slot_to_roster_id ?? {}).map(([slot, rosterId]) => [slot, Number(rosterId)]),
  );
  const nextUserPick = findNextUserSelection(
    board.currentOverallPick,
    board.teams,
    board.rounds,
    draftType,
    userDraftSlot,
    { userRosterId, slotToRosterId, tradedPicks },
  );
  const interveningSelections: DraftSelectionContext[] = [];
  if (nextUserPick !== null && draftType !== 'auction' && draftType !== 'unknown') {
    for (let overallPick = board.currentOverallPick; overallPick < nextUserPick; overallPick += 1) {
      const selection = selectionOwner(
        overallPick,
        board.teams,
        draftType,
        slotToRosterId,
        tradedPicks,
      );
      if (selection.ownerRosterId !== userRosterId) interveningSelections.push(selection);
    }
  }
  return value(
    {
      rounds: board.rounds,
      currentPick: board.currentOverallPick,
      currentRound: board.currentRound,
      userDraftSlot,
      userRosterId,
      nextUserPick,
      picksBeforeNextSelection:
        nextUserPick === null ? null : Math.max(0, nextUserPick - board.currentOverallPick),
      interveningSelections,
      draftedPlayerIds: [...board.draftedSleeperIds],
      keeperPlayerIds: picks.filter((pick) => pick.is_keeper).map((pick) => pick.player_id),
      tradedPicks: [...tradedPicks],
      slotToRosterId,
    },
    'draft, picks, rosters, keeper markers and traded picks',
    draftType === 'unknown' ? 'low' : 'high',
  );
}

export function normalizeLeagueContext(input: NormalizeLeagueContextInput): LeagueContext {
  const detectedLeague = detectedLeagueType(input.league);
  const detectedDraft = detectedDraftType(input.draft);
  const detectedLineup = detectedLineupType(input.league);
  const leagueType = input.overrides?.leagueType
    ? value(input.overrides.leagueType, 'manual override', 'high')
    : detectedLeague;
  const draftType = input.overrides?.draftType
    ? value(input.overrides.draftType, 'manual override', 'high')
    : detectedDraft;
  const lineupType = input.overrides?.lineupType
    ? value(input.overrides.lineupType, 'manual override', 'high')
    : detectedLineup;
  const detectedContext = detectDraftContext(
    leagueType.value,
    input.draft,
    input.drafts,
    input.rosters,
  );
  const draftContext = input.overrides?.draftContext
    ? value(input.overrides.draftContext, 'manual override', 'high')
    : detectedContext;
  const keeperSettings = normalizeKeeperSettings(leagueType.value, input.league);
  if (input.overrides?.keeperSettings) {
    keeperSettings.value = { ...keeperSettings.value, ...input.overrides.keeperSettings };
    keeperSettings.source = 'Sleeper detection + manual override';
    keeperSettings.confidence = keeperSettings.value.rulesFullyKnown ? 'high' : 'medium';
  }
  const warnings: string[] = [];
  if (leagueType.value === 'unknown') {
    warnings.push('Sleeper returned an unrecognized league type. Select a manual format before using recommendations.');
  }
  if (leagueType.value === 'dynasty' && draftContext.value === 'unknown') {
    warnings.push('Dynasty league detected, but Sleeper did not identify whether this is a startup or supplemental draft.');
  }
  if (draftContext.confidence === 'medium') {
    warnings.push('Draft context is inferred from roster occupancy and undocumented Sleeper draft fields; verify it manually.');
  }
  if (lineupType.value === 'unknown') {
    warnings.push('Sleeper did not expose a reliable Classic or Best Ball flag.');
  }
  if (input.league.scoring_settings === null) {
    warnings.push('Sleeper returned no scoring settings; scoring defaults are visible but low-confidence.');
  }
  if (leagueType.value === 'keeper' && !keeperSettings.value.rulesFullyKnown) {
    warnings.push('Keeper league detected, but keeper costs and escalation rules are not available from Sleeper.');
  }

  return {
    leagueType,
    draftContext,
    draftType,
    lineupType,
    teams: value(input.board.teams, 'draft.settings.teams / league rosters', 'high'),
    roster: normalizeRoster(input.league, input.draft),
    scoring: normalizeScoring(input.league),
    keeperSettings,
    draftState: normalizeDraftState(input, draftType.value),
    warnings,
  };
}
