import { normalizePosition } from '../../players/player-map';
import {
  ProjectionCsvError,
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
  };

  return rows.slice(1).map((row, index) => {
    const sourceRow = index + 2;
    const playerName = row[columns.playerName]?.trim();
    if (!playerName) {
      throw new ProjectionCsvError('Player name is required.', sourceRow);
    }

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
    };
  });
}

export class CsvProjectionProvider implements ProjectionProvider {
  readonly id = 'csv';
  readonly label = 'CSV upload';

  constructor(private readonly input: string) {}

  async getRecords(): Promise<ProjectionRecord[]> {
    return parseProjectionCsv(this.input);
  }
}
