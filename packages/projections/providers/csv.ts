import { normalizePosition } from '../../players/player-map';
import {
  ProjectionCsvError,
  type AdpFormat,
  type ProjectionProvider,
  type ProjectionRecord,
} from '../types';

type CsvRow = string[];

const HEADER_ALIASES = {
  playerName: ['player', 'name', 'player_name', 'full_name'],
  sleeperId: ['sleeper_id', 'sleeperid'],
  position: ['position', 'pos'],
  projection: ['projection', 'projected_points', 'points', 'fpts'],
  adp: ['adp', 'average_draft_position'],
  rank: ['rank', 'overall_rank', 'ecr'],
  adpFormat: ['adp_format', 'format'],
  projectionScoring: ['projection_scoring', 'scoring_format'],
  passingYards: ['pass_yd', 'passing_yards'],
  passingTouchdowns: ['pass_td', 'passing_touchdowns'],
  interceptions: ['pass_int', 'interceptions'],
  rushingYards: ['rush_yd', 'rushing_yards'],
  rushingTouchdowns: ['rush_td', 'rushing_touchdowns'],
  receptions: ['rec', 'receptions'],
  receivingYards: ['rec_yd', 'receiving_yards'],
  receivingTouchdowns: ['rec_td', 'receiving_touchdowns'],
  fumblesLost: ['fum_lost', 'fumbles_lost'],
} as const;

function parseRows(input: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    const next = input[index + 1];

    if (character === '"') {
      if (quoted && next === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (character === ',' && !quoted) {
      row.push(value.trim());
      value = '';
      continue;
    }

    if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && next === '\n') index += 1;
      row.push(value.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      value = '';
      continue;
    }

    value += character;
  }

  if (quoted) throw new ProjectionCsvError('CSV contains an unclosed quote.');
  row.push(value.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function normalizeHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function findColumn(headers: string[], aliases: readonly string[]): number {
  return headers.findIndex((header) => aliases.includes(header));
}

function requiredColumn(
  headers: string[],
  aliases: readonly string[],
  displayName: string,
): number {
  const index = findColumn(headers, aliases);
  if (index === -1) {
    throw new ProjectionCsvError(`Missing required “${displayName}” column.`);
  }
  return index;
}

function parseNumber(value: string | undefined, field: string, row: number): number {
  const parsed = Number(value);
  if (!value || !Number.isFinite(parsed)) {
    throw new ProjectionCsvError(`${field} must be a number.`, row);
  }
  return parsed;
}

function optionalNumber(value: string | undefined, field: string, row: number) {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ProjectionCsvError(`${field} must be a number.`, row);
  }
  return parsed;
}

export function parseProjectionCsv(input: string): ProjectionRecord[] {
  const rows = parseRows(input);
  if (rows.length < 2) {
    throw new ProjectionCsvError('CSV needs a header and at least one player row.');
  }

  const headers = rows[0].map(normalizeHeader);
  const columns = {
    playerName: requiredColumn(headers, HEADER_ALIASES.playerName, 'player'),
    position: requiredColumn(headers, HEADER_ALIASES.position, 'position'),
    projection: requiredColumn(headers, HEADER_ALIASES.projection, 'projection'),
    adp: requiredColumn(headers, HEADER_ALIASES.adp, 'adp'),
    rank: requiredColumn(headers, HEADER_ALIASES.rank, 'rank'),
    sleeperId: findColumn(headers, HEADER_ALIASES.sleeperId),
    adpFormat: findColumn(headers, HEADER_ALIASES.adpFormat),
    projectionScoring: findColumn(headers, HEADER_ALIASES.projectionScoring),
    passingYards: findColumn(headers, HEADER_ALIASES.passingYards),
    passingTouchdowns: findColumn(headers, HEADER_ALIASES.passingTouchdowns),
    interceptions: findColumn(headers, HEADER_ALIASES.interceptions),
    rushingYards: findColumn(headers, HEADER_ALIASES.rushingYards),
    rushingTouchdowns: findColumn(headers, HEADER_ALIASES.rushingTouchdowns),
    receptions: findColumn(headers, HEADER_ALIASES.receptions),
    receivingYards: findColumn(headers, HEADER_ALIASES.receivingYards),
    receivingTouchdowns: findColumn(headers, HEADER_ALIASES.receivingTouchdowns),
    fumblesLost: findColumn(headers, HEADER_ALIASES.fumblesLost),
  };

  return rows.slice(1).map((row, index) => {
    const sourceRow = index + 2;
    const playerName = row[columns.playerName]?.trim();
    if (!playerName) {
      throw new ProjectionCsvError('Player name is required.', sourceRow);
    }

    const stats = {
      passingYards: optionalNumber(row[columns.passingYards], 'Passing yards', sourceRow),
      passingTouchdowns: optionalNumber(
        row[columns.passingTouchdowns],
        'Passing touchdowns',
        sourceRow,
      ),
      interceptions: optionalNumber(
        row[columns.interceptions],
        'Interceptions',
        sourceRow,
      ),
      rushingYards: optionalNumber(row[columns.rushingYards], 'Rushing yards', sourceRow),
      rushingTouchdowns: optionalNumber(
        row[columns.rushingTouchdowns],
        'Rushing touchdowns',
        sourceRow,
      ),
      receptions: optionalNumber(row[columns.receptions], 'Receptions', sourceRow),
      receivingYards: optionalNumber(
        row[columns.receivingYards],
        'Receiving yards',
        sourceRow,
      ),
      receivingTouchdowns: optionalNumber(
        row[columns.receivingTouchdowns],
        'Receiving touchdowns',
        sourceRow,
      ),
      fumblesLost: optionalNumber(row[columns.fumblesLost], 'Fumbles lost', sourceRow),
    };
    const hasStats = Object.values(stats).some((value) => value !== undefined);

    return {
      sourceRow,
      playerName,
      sleeperId:
        columns.sleeperId >= 0 && row[columns.sleeperId]
          ? row[columns.sleeperId]
          : undefined,
      position: normalizePosition(row[columns.position]),
      projection: parseNumber(
        row[columns.projection],
        'Projection',
        sourceRow,
      ),
      adp: parseNumber(row[columns.adp], 'ADP', sourceRow),
      rank: parseNumber(row[columns.rank], 'Rank', sourceRow),
      ...(columns.adpFormat >= 0 && row[columns.adpFormat]
        ? { adpFormat: normalizeAdpFormat(row[columns.adpFormat]) }
        : {}),
      ...(columns.projectionScoring >= 0 && row[columns.projectionScoring]
        ? { projectionScoring: row[columns.projectionScoring].trim() }
        : {}),
      ...(hasStats ? { stats } : {}),
    };
  });
}

function normalizeAdpFormat(value: string): AdpFormat {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (
    normalized === 'redraft_1qb' ||
    normalized === 'redraft_superflex' ||
    normalized === 'dynasty_startup' ||
    normalized === 'dynasty_rookie'
  ) {
    return normalized;
  }
  return 'unknown';
}

export class CsvProjectionProvider implements ProjectionProvider {
  readonly id = 'csv';
  readonly label = 'CSV upload';

  constructor(private readonly input: string) {}

  async getRecords(): Promise<ProjectionRecord[]> {
    return parseProjectionCsv(this.input);
  }
}
