import { normalizePosition } from '../../players/player-map';
import type {
  AdpProvider,
  AdpProviderRequest,
  AdpSourceSnapshot,
  RawAdpRecord,
  SourceConfidence,
} from '../../data/types';

const BASE_URL = 'https://fantasyfootballcalculator.com/api/v1/adp';
const MINIMUM_VALID_PLAYERS = 80;

interface FfcPlayer {
  player_id?: number | string;
  name?: string;
  position?: string;
  team?: string;
  adp?: number;
  times_drafted?: number;
  stdev?: number;
}

interface FfcResponse {
  status?: string;
  meta?: {
    type?: string;
    teams?: number;
    rounds?: number;
    total_drafts?: number;
    start_date?: string;
    end_date?: string;
  };
  players?: FfcPlayer[];
}

export class AdpProviderResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdpProviderResponseError';
  }
}

function sourceConfidence(sampleSize: number): SourceConfidence {
  if (sampleSize >= 500) return 'high';
  if (sampleSize >= 100) return 'medium';
  return 'low';
}

function scoringFormat(request: AdpProviderRequest) {
  if (request.format === 'ppr') return 'full_ppr' as const;
  if (request.format === 'half-ppr') return 'half_ppr' as const;
  if (request.format === 'standard') return 'standard' as const;
  return 'unknown' as const;
}

function normalizePlayer(player: FfcPlayer, index: number): RawAdpRecord | null {
  const playerName = player.name?.trim();
  const position = normalizePosition(player.position);
  if (
    !playerName ||
    position === 'UNKNOWN' ||
    typeof player.adp !== 'number' ||
    !Number.isFinite(player.adp) ||
    player.adp <= 0
  ) {
    return null;
  }
  return {
    providerPlayerId:
      player.player_id === undefined ? undefined : String(player.player_id),
    playerName,
    position,
    team: player.team?.trim() || null,
    adp: player.adp,
    rank: index + 1,
    sampleSize:
      typeof player.times_drafted === 'number' && player.times_drafted >= 0
        ? player.times_drafted
        : null,
    standardDeviation:
      typeof player.stdev === 'number' && Number.isFinite(player.stdev)
        ? player.stdev
        : null,
  };
}

export function normalizeFantasyFootballCalculatorResponse({
  payload,
  request,
  fetchedAt = new Date(),
}: {
  payload: unknown;
  request: AdpProviderRequest;
  fetchedAt?: Date;
}): AdpSourceSnapshot {
  if (!payload || typeof payload !== 'object') {
    throw new AdpProviderResponseError('Fantasy Football Calculator returned non-object data.');
  }
  const response = payload as FfcResponse;
  if (response.status !== 'Success' || !response.meta || !Array.isArray(response.players)) {
    throw new AdpProviderResponseError('Fantasy Football Calculator returned a malformed response.');
  }
  if (response.meta.teams !== request.teams) {
    throw new AdpProviderResponseError('Fantasy Football Calculator returned the wrong league size.');
  }
  const records = response.players
    .map(normalizePlayer)
    .filter((record): record is RawAdpRecord => record !== null);
  const invalidCount = response.players.length - records.length;
  if (
    records.length < MINIMUM_VALID_PLAYERS ||
    invalidCount > Math.max(5, response.players.length * 0.05)
  ) {
    throw new AdpProviderResponseError(
      'Fantasy Football Calculator returned an incomplete player dataset.',
    );
  }
  const totalDrafts = Math.max(0, response.meta.total_drafts ?? 0);
  const sourceUpdatedAt = response.meta.end_date
    ? `${response.meta.end_date}T00:00:00.000Z`
    : null;
  return {
    kind: 'adp-source',
    provenance: {
      sourceId: 'fantasy-football-calculator',
      sourceLabel: 'Fantasy Football Calculator',
      season: request.season,
      fetchedAt: fetchedAt.toISOString(),
      sourceUpdatedAt,
      sourceConfidence: sourceConfidence(totalDrafts),
      attributionLabel: 'Fantasy Football Calculator ADP',
      attributionUrl: 'https://fantasyfootballcalculator.com/adp',
    },
    context: {
      leagueFormat:
        request.format === '2qb' ? 'redraft_superflex' : 'redraft_1qb',
      qbFormat: request.format === '2qb' ? 'superflex' : '1qb',
      scoringFormat: scoringFormat(request),
      teams: request.teams,
      sampleSize: totalDrafts || null,
    },
    records,
  };
}

export function isAdpSourceSnapshot(value: unknown): value is AdpSourceSnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AdpSourceSnapshot>;
  return (
    candidate.kind === 'adp-source' &&
    !!candidate.provenance &&
    typeof candidate.provenance.sourceId === 'string' &&
    typeof candidate.provenance.sourceLabel === 'string' &&
    /^20\d{2}$/.test(candidate.provenance.season) &&
    typeof candidate.provenance.fetchedAt === 'string' &&
    Number.isFinite(Date.parse(candidate.provenance.fetchedAt)) &&
    !!candidate.context &&
    Number.isFinite(candidate.context.teams) &&
    candidate.context.teams > 0 &&
    Array.isArray(candidate.records) &&
    candidate.records.length >= MINIMUM_VALID_PLAYERS &&
    candidate.records.every(
      (record) =>
        !!record &&
        typeof record.playerName === 'string' &&
        record.playerName.trim().length > 0 &&
        typeof record.position === 'string' &&
        record.position !== 'UNKNOWN' &&
        Number.isFinite(record.adp) &&
        record.adp > 0 &&
        Number.isFinite(record.rank) &&
        record.rank > 0,
    )
  );
}

export class FantasyFootballCalculatorAdpProvider implements AdpProvider {
  readonly id = 'fantasy-football-calculator';
  readonly label = 'Fantasy Football Calculator';

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly baseUrl = BASE_URL,
  ) {}

  async getSnapshot(request: AdpProviderRequest): Promise<AdpSourceSnapshot> {
    const url = new URL(`${this.baseUrl}/${request.format}`);
    url.searchParams.set('teams', String(request.teams));
    url.searchParams.set('year', request.season);
    const response = await this.fetcher(url, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new AdpProviderResponseError(
        `Fantasy Football Calculator request failed (${response.status}).`,
      );
    }
    return normalizeFantasyFootballCalculatorResponse({
      payload: await response.json(),
      request,
    });
  }
}
