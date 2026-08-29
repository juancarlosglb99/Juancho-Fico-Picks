/**
 * The CSV reader, in plain JavaScript, for the build script only.
 *
 * `packages/fantasy-pros/csv.ts` is the version the application uses and the
 * one the tests cover; this is the same rules expressed for a script that runs
 * outside the bundler. Both are small, and both are exercised: the script's
 * output is committed, so a divergence shows up as a diff.
 */
export function parseCsv(input) {
  const rows = [];
  let row = [];
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
    } else if (character === ',' && !quoted) {
      row.push(value.trim());
      value = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (value || row.length > 0) {
        row.push(value.trim());
        rows.push(row);
        row = [];
        value = '';
      }
      if (character === '\r' && next === '\n') index += 1;
    } else {
      value += character;
    }
  }
  if (value || row.length > 0) {
    row.push(value.trim());
    rows.push(row);
  }
  return rows;
}

export function parseFantasyProsRankings(input) {
  const rows = parseCsv(input);
  if (rows.length === 0) return [];
  const header = rows[0].map((cell) => cell.trim().toUpperCase());
  const index = {
    rank: header.indexOf('RK'),
    name: header.indexOf('PLAYER NAME'),
    team: header.indexOf('TEAM'),
    position: header.indexOf('POS'),
  };
  const parsed = [];
  for (const row of rows.slice(1)) {
    const match = /^([A-Za-z]+)(\d+)$/.exec((row[index.position] ?? '').trim());
    if (!match) continue;
    const raw = match[1].toUpperCase();
    const position = raw === 'DST' ? 'DEF' : raw === 'K' ? 'K' : null;
    if (!position) continue;
    const sourceName = (row[index.name] ?? '').trim();
    if (!sourceName) continue;
    parsed.push({
      sourceName,
      team: (row[index.team] ?? '').trim() || null,
      position,
      positionRank: Number(match[2]),
      overallRank: Number(row[index.rank] ?? '') || Number(match[2]),
    });
  }
  return parsed.sort((a, b) => a.positionRank - b.positionRank);
}
