/**
 * The verification step, between choosing a draft and entering the room.
 *
 * The old screen dropped a connected user straight into a wall of panels and
 * left them to work out whether anything was actually loaded. Everything the
 * recommendation depends on is checked here instead, once, before the clock
 * starts - because "First Seed did not load" is a five-second problem before a
 * draft and an unrecoverable one during it.
 *
 * Every check reports what it found rather than a bare tick. `4 of 12 teams`
 * tells someone what to do; `Warning` does not.
 */
import type { LeagueContext } from '../engine/context/types';
import type {
  AdpSnapshot,
  DraftRoomRankingSnapshot,
  ProjectionSnapshot,
} from '../data/types';
import type { DraftAttachment } from '../sleeper/attachment';
import type { SleeperDraft } from '../sleeper/types';
import { displayEnum } from './theme';

export type CheckStatus = 'ok' | 'warn' | 'missing' | 'unknown';

export interface ReadinessCheck {
  id: string;
  label: string;
  status: CheckStatus;
  value: string;
  detail: string;
  /** True when the draft genuinely cannot be run without it. */
  blocking: boolean;
}

export interface DraftReadiness {
  league: {
    name: string;
    isMock: boolean;
    teams: number;
    rounds: number;
    scoring: string;
    lineup: string;
    rosterSummary: string;
    draftType: string;
    draftStatus: string;
  };
  us: {
    teamName: string | null;
    rosterId: number | null;
    draftSlot: number | null;
  };
  checks: ReadinessCheck[];
  ready: boolean;
  /** The checks standing between here and a usable draft room. */
  blockers: ReadinessCheck[];
}

export function buildDraftReadiness({
  attachment,
  draft,
  context,
  projections,
  roomRankings,
  adp,
  ourTeamName,
  aiAvailable,
}: {
  attachment: DraftAttachment;
  draft: SleeperDraft;
  context: LeagueContext;
  projections: ProjectionSnapshot | null;
  roomRankings: DraftRoomRankingSnapshot | null;
  adp: AdpSnapshot | null;
  ourTeamName: string | null;
  /** Null while the server has not been asked whether a key is configured. */
  aiAvailable: boolean | null;
}): DraftReadiness {
  const roster = context.roster.value;
  const state = context.draftState.value;

  const checks: ReadinessCheck[] = [
    projectionCheck(projections),
    roomRankingCheck(roomRankings),
    adpCheck(adp),
    seatCheck(state.userRosterId, state.userDraftSlot),
    formatCheck(context),
    aiCheck(aiAvailable),
  ];

  /*
   * Only a MISSING blocking source stops a draft. A degraded one - a board that
   * does not exactly match the format, a projection set with unmatched rows -
   * is worth saying out loud and is not worth refusing to draft over.
   */
  const blockers = checks.filter((check) => check.blocking && check.status === 'missing');

  return {
    league: {
      name: attachment.league.name,
      isMock: attachment.source === 'mock',
      teams: context.teams.value,
      rounds: state.rounds,
      scoring: describeScoring(context),
      lineup: displayEnum(context.lineupType.value),
      rosterSummary: describeRoster(roster),
      draftType: displayEnum(context.draftType.value),
      draftStatus: draft.status === 'pre_draft' ? 'Upcoming' : displayEnum(draft.status),
    },
    us: {
      teamName: ourTeamName,
      rosterId: state.userRosterId,
      draftSlot: state.userDraftSlot,
    },
    checks,
    ready: blockers.length === 0,
    blockers,
  };
}

function describeScoring(context: LeagueContext): string {
  const scoring = context.scoring.value;
  const ppr = scoring.reception.base;
  const label = ppr >= 1 ? 'Full PPR' : ppr > 0 ? `${ppr} PPR` : 'Standard';
  const tePremium =
    scoring.tePremium > 0 ? ` · ${scoring.tePremium} TE premium` : '';
  return `${label}${tePremium}`;
}

function describeRoster(roster: LeagueContext['roster']['value']): string {
  const parts = [
    `${roster.QB}QB`,
    `${roster.RB}RB`,
    `${roster.WR}WR`,
    `${roster.TE}TE`,
  ];
  if (roster.FLEX > 0) parts.push(`${roster.FLEX}FLEX`);
  if (roster.SUPER_FLEX > 0) parts.push(`${roster.SUPER_FLEX}SF`);
  if (roster.K > 0) parts.push(`${roster.K}K`);
  if (roster.DEF > 0) parts.push(`${roster.DEF}DEF`);
  if (roster.bench > 0) parts.push(`${roster.bench}BN`);
  return parts.join(' · ');
}

function projectionCheck(projections: ProjectionSnapshot | null): ReadinessCheck {
  if (!projections) {
    return {
      id: 'projections',
      label: 'First Seed projections',
      status: 'missing',
      value: 'Not loaded',
      detail: 'Recommendations need a projection source. Retry, or import a CSV override.',
      blocking: true,
    };
  }
  const { matched, total } = projections.resolution;
  const rate = total === 0 ? 0 : matched / total;
  return {
    id: 'projections',
    label: 'First Seed projections',
    status: rate >= 0.9 ? 'ok' : 'warn',
    value: `${matched.toLocaleString()} players`,
    detail: `${projections.provenance.sourceLabel} · ${projections.unmatched.length} row${projections.unmatched.length === 1 ? '' : 's'} unmatched.`,
    blocking: true,
  };
}

function roomRankingCheck(rankings: DraftRoomRankingSnapshot | null): ReadinessCheck {
  if (!rankings) {
    return {
      id: 'room_rankings',
      label: 'Sleeper draft-room board',
      status: 'missing',
      value: 'Not loaded',
      /*
       * Not blocking, and deliberately so. Without a published board the engine
       * refuses to anchor to one and says so; the recommendation still works,
       * it simply has no consensus to reach past.
       */
      detail:
        'The engine will run without a consensus board, but availability estimates lose confidence.',
      blocking: false,
    };
  }
  const compatible = rankings.compatibility.level === 'exact';
  return {
    id: 'room_rankings',
    label: 'Sleeper draft-room board',
    status: compatible ? 'ok' : 'warn',
    value: `${rankings.records.length.toLocaleString()} ranked`,
    detail: compatible
      ? `${rankings.context.sheet} · matches this league's format.`
      : rankings.compatibility.reasons[0] ?? 'The board does not exactly match this format.',
    blocking: false,
  };
}

function adpCheck(adp: AdpSnapshot | null): ReadinessCheck {
  if (!adp) {
    return {
      id: 'adp',
      label: 'Market ADP',
      status: 'missing',
      value: 'Not loaded',
      detail: 'Used only to flag market value. Nothing depends on it.',
      blocking: false,
    };
  }
  return {
    id: 'adp',
    label: 'Market ADP',
    status: adp.compatibility.level === 'exact' ? 'ok' : 'warn',
    value: `${adp.context.teams}-team ${displayEnum(adp.context.scoringFormat)}`,
    detail: adp.provenance.sourceLabel,
    blocking: false,
  };
}

/**
 * Which seat is ours.
 *
 * The single most damaging thing to get wrong: an engine that thinks it is
 * drafting for the wrong seat gives advice that is confidently, consistently
 * about somebody else's roster.
 */
function seatCheck(rosterId: number | null, draftSlot: number | null): ReadinessCheck {
  if (rosterId === null && draftSlot === null) {
    return {
      id: 'seat',
      label: 'Your seat in this draft',
      status: 'missing',
      value: 'Not identified',
      detail:
        'Sleeper has not attributed a roster or a draft slot to this account, so no roster can be built for you.',
      blocking: true,
    };
  }
  return {
    id: 'seat',
    label: 'Your seat in this draft',
    status: 'ok',
    value: draftSlot !== null ? `Draft slot ${draftSlot}` : `Roster ${rosterId}`,
    detail:
      draftSlot !== null && rosterId !== null
        ? `Slot ${draftSlot} maps to roster ${rosterId}.`
        : 'Identified from the draft order.',
    blocking: true,
  };
}

function formatCheck(context: LeagueContext): ReadinessCheck {
  const type = context.leagueType.value;
  const draftType = context.draftType.value;
  const unsupported =
    type === 'dynasty' || draftType === 'auction' || type === 'unknown';
  return {
    id: 'format',
    label: 'Format support',
    status: unsupported ? 'missing' : context.warnings.length > 0 ? 'warn' : 'ok',
    value: `${displayEnum(type)} · ${displayEnum(draftType)}`,
    detail: unsupported
      ? type === 'dynasty'
        ? 'Dynasty valuation is deliberately not derived from redraft projections.'
        : draftType === 'auction'
          ? 'Auction budgets and nomination are outside the current engine.'
          : 'Confirm the league type before the draft starts.'
      : context.warnings[0] ?? 'Fully supported.',
    blocking: unsupported,
  };
}

function aiCheck(available: boolean | null): ReadinessCheck {
  if (available === null) {
    return {
      id: 'ai',
      label: 'AI strategist',
      status: 'unknown',
      value: 'Checking',
      detail: 'Asking the server whether a strategist is configured.',
      blocking: false,
    };
  }
  return {
    id: 'ai',
    label: 'AI strategist',
    status: available ? 'ok' : 'warn',
    value: available ? 'Available' : 'Not configured',
    detail: available
      ? 'One call per turn of yours. The deterministic recommendation is shown either way.'
      : 'The draft runs on the deterministic engine alone.',
    blocking: false,
  };
}
