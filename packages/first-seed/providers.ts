import type {
  DraftRoomPlatform,
  DraftRoomRankingSourceSnapshot,
  PlayerSignal,
  PlayerSignalProvider,
  PlayerSignalSnapshot,
  ProjectionSourceSnapshot,
  RawDraftRoomRankingRecord,
} from '../data/types';
import type { ScoringProfile } from '../engine/context/types';
import { normalizePosition } from '../players/player-map';
import type { ProjectionRecord } from '../projections/types';
import { finiteNumber, normalizedHeader, parseCsv, sheetDate } from './csv';

export const FIRST_SEED_URL = 'https://firstseedsports.com/';
export const JUICE_SHEETS_ID = '199izMhbkOOjTsNmrK-D56dYnnViJBYFfBEtxK268h4Y';
export const ABUSING_RANKINGS_ID = '1HTixsrRtIIpnUafVkOIhET83vCFjKXSUGiG24-5jTHY';
const MINIMUM_PROJECTIONS = 100;
const MINIMUM_ROOM_RANKINGS = 80;

function gvizUrl(spreadsheetId: string, sheet: string): string {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq`);
  url.searchParams.set('tqx', 'out:csv');
  url.searchParams.set('sheet', sheet);
  return url.toString();
}

async function fetchCsv(fetcher: typeof fetch, spreadsheetId: string, sheet: string) {
  const response = await fetcher(gvizUrl(spreadsheetId, sheet), {
    headers: { Accept: 'text/csv' },
  });
  if (!response.ok) {
    throw new Error(`First Seed sheet request failed (${response.status}).`);
  }
  const text = await response.text();
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('First Seed returned an empty sheet.');
  return rows;
}

function headerIndex(headers: string[], aliases: string[]): number {
  return headers.findIndex((header) => aliases.includes(normalizedHeader(header)));
}

function requiredHeader(headers: string[], aliases: string[], label: string): number {
  const index = headerIndex(headers, aliases);
  if (index < 0) throw new Error(`First Seed is missing the ${label} column.`);
  return index;
}

function scoringColumn(format: ScoringProfile): string {
  if (format === 'standard') return 'proj std';
  if (format === 'half_ppr') return 'proj half';
  if (format === 'full_ppr') return 'proj ppr';
  throw new Error('First Seed aggregate projections do not support custom scoring.');
}

export class FirstSeedProjectionProvider {
  readonly id = 'first-seed-juicesheets';
  readonly label = 'First Seed JuiceSheets';

  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async getSnapshot({
    season,
    scoringFormat,
    fetchedAt = new Date(),
  }: {
    season: string;
    scoringFormat: ScoringProfile;
    fetchedAt?: Date;
  }): Promise<ProjectionSourceSnapshot> {
    const [combined, introduction] = await Promise.all([
      fetchCsv(this.fetcher, JUICE_SHEETS_ID, 'Combined'),
      fetchCsv(this.fetcher, JUICE_SHEETS_ID, 'Introduction'),
    ]);
    const headers = combined[0];
    const columns = {
      player: requiredHeader(headers, ['player'], 'player'),
      position: requiredHeader(headers, ['pos', 'position'], 'position'),
      team: headerIndex(headers, ['team']),
      projection: requiredHeader(headers, [scoringColumn(scoringFormat)], 'projection'),
    };
    const records: ProjectionRecord[] = combined.slice(1).flatMap((row, index) => {
      const playerName = row[columns.player]?.trim();
      const position = normalizePosition(row[columns.position]);
      const projection = finiteNumber(row[columns.projection]);
      if (!playerName || position === 'UNKNOWN' || projection === null || projection < 0) {
        return [];
      }
      return [{
        sourceRow: index + 2,
        playerName,
        position,
        team: columns.team >= 0 ? row[columns.team]?.trim().toUpperCase() || null : null,
        projection,
        projectionScoring: scoringFormat,
      }];
    });
    const unique = new Map(records.map((record) => [
      `${normalizedHeader(record.playerName)}|${record.position}`,
      record,
    ]));
    if (unique.size < MINIMUM_PROJECTIONS) {
      throw new Error('First Seed JuiceSheets returned an incomplete projection dataset.');
    }
    return {
      kind: 'projection-source',
      provenance: {
        sourceId: this.id,
        sourceLabel: this.label,
        season,
        fetchedAt: fetchedAt.toISOString(),
        sourceUpdatedAt: sheetDate(introduction),
        sourceConfidence: 'high',
        attributionLabel: 'First Seed Sports',
        attributionUrl: FIRST_SEED_URL,
      },
      sheet: 'Combined',
      scoringFormat,
      records: [...unique.values()],
    };
  }
}

function rankingSheet({
  platform,
  scoringFormat,
  qbFormat,
}: {
  platform: DraftRoomPlatform;
  scoringFormat: ScoringProfile;
  qbFormat: '1qb' | 'superflex';
}): string {
  const prefix = platform === 'cbs' ? 'CBS' : platform[0].toUpperCase() + platform.slice(1);
  if (platform === 'sleeper' && qbFormat === 'superflex') return 'Sleeper Superflex';
  if (platform === 'cbs') return 'CBS PPR';
  if (scoringFormat === 'standard') return `${prefix} Standard`;
  if (scoringFormat === 'half_ppr') return `${prefix} Half PPR`;
  if (scoringFormat === 'full_ppr') return `${prefix} PPR`;
  throw new Error('First Seed room rankings do not support custom scoring.');
}

function rankAliases(platform: DraftRoomPlatform): string[] {
  if (platform === 'sleeper') return ['sleeper adp', 'sleeper rank', 'sleeperrank'];
  if (platform === 'espn') return ['espn', 'espn rank', 'espn adp'];
  if (platform === 'yahoo') {
    return ['yahoo', 'yahoo rank', 'xrank', 'yahoo xrank', 'yahooxrank'];
  }
  return ['cbs', 'cbs rank', 'cbs adp'];
}

export class FirstSeedDraftRoomRankingProvider {
  readonly id = 'first-seed-draft-room-rankings';
  readonly label = 'First Seed draft-room rankings';

  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async getSnapshot({
    season,
    platform,
    scoringFormat,
    qbFormat,
    fetchedAt = new Date(),
  }: {
    season: string;
    platform: DraftRoomPlatform;
    scoringFormat: ScoringProfile;
    qbFormat: '1qb' | 'superflex';
    fetchedAt?: Date;
  }): Promise<DraftRoomRankingSourceSnapshot> {
    const sheet = rankingSheet({ platform, scoringFormat, qbFormat });
    const [table, main] = await Promise.all([
      fetchCsv(this.fetcher, ABUSING_RANKINGS_ID, sheet),
      fetchCsv(this.fetcher, ABUSING_RANKINGS_ID, 'Main'),
    ]);
    const headerRowIndex = table.findIndex((row) => {
      const normalized = row.map(normalizedHeader);
      return normalized.includes('name') && normalized.includes('pos');
    });
    if (headerRowIndex < 0) throw new Error('First Seed room rankings have no header row.');
    const headers = table[headerRowIndex];
    const columns = {
      player: requiredHeader(headers, ['name', 'player'], 'player'),
      position: requiredHeader(headers, ['pos', 'position'], 'position'),
      team: headerIndex(headers, ['team']),
      rank: requiredHeader(headers, rankAliases(platform), `${platform} room rank`),
      upstreamMarketAdp: headerIndex(headers, ['adp']),
      upstreamExpertRank: headerIndex(headers, ['fantasypros', 'fantasypros rank']),
      firstSeedLandmineScore: headerIndex(headers, ['landmine', 'landmine score']),
    };
    const valueColumn = headers.findIndex((header) => normalizedHeader(header).endsWith('vfp'));
    const records: RawDraftRoomRankingRecord[] = table
      .slice(headerRowIndex + 1)
      .flatMap((row, index) => {
        const playerName = row[columns.player]?.trim();
        const position = normalizePosition(row[columns.position]);
        const rank = finiteNumber(row[columns.rank]);
        if (!playerName || position === 'UNKNOWN' || rank === null || rank <= 0) return [];
        return [{
          sourceRow: headerRowIndex + index + 2,
          playerName,
          position,
          team: columns.team >= 0 ? row[columns.team]?.trim().toUpperCase() || null : null,
          rank,
          upstreamMarketAdp: columns.upstreamMarketAdp >= 0
            ? finiteNumber(row[columns.upstreamMarketAdp])
            : null,
          upstreamExpertRank: columns.upstreamExpertRank >= 0
            ? finiteNumber(row[columns.upstreamExpertRank])
            : null,
          firstSeedValueDelta: valueColumn >= 0 ? finiteNumber(row[valueColumn]) : null,
          firstSeedLandmineScore: columns.firstSeedLandmineScore >= 0
            ? finiteNumber(row[columns.firstSeedLandmineScore])
            : null,
        }];
      });
    if (records.length < MINIMUM_ROOM_RANKINGS) {
      throw new Error('First Seed returned an incomplete draft-room ranking dataset.');
    }
    return {
      kind: 'draft-room-ranking-source',
      provenance: {
        sourceId: this.id,
        sourceLabel: `${this.label} · ${platform[0].toUpperCase()}${platform.slice(1)}`,
        season,
        fetchedAt: fetchedAt.toISOString(),
        sourceUpdatedAt: sheetDate(main),
        sourceConfidence: 'high',
        attributionLabel: 'First Seed Sports',
        attributionUrl: FIRST_SEED_URL,
      },
      context: { platform, scoringFormat, qbFormat, sheet },
      records,
    };
  }
}

/**
 * Conservative structured-signal adapter. Newsletter prose must be normalized
 * upstream; this provider never converts editorial language into point changes.
 */
export class FirstSeedSignalProvider implements PlayerSignalProvider {
  readonly id = 'first-seed-signals';
  readonly label = 'First Seed weekly signals';

  constructor(
    private readonly season: string,
    private readonly loadRecords: () => Promise<PlayerSignal[]>,
    private readonly sourceUrl = 'https://newsletter.firstseedsports.com/',
  ) {}

  async getSnapshot(): Promise<PlayerSignalSnapshot> {
    const records = await this.loadRecords();
    return {
      kind: 'player-signals',
      provenance: {
        sourceId: this.id,
        sourceLabel: this.label,
        season: this.season,
        fetchedAt: new Date().toISOString(),
        sourceUpdatedAt: records[0]?.observedAt ?? null,
        sourceConfidence: records.length > 0 ? 'medium' : 'low',
        attributionLabel: 'First Seed Sports',
        attributionUrl: this.sourceUrl,
      },
      records,
    };
  }
}

export const FIRST_SEED_REFRESH_INTERVAL_MS = 4 * 24 * 60 * 60 * 1000;
