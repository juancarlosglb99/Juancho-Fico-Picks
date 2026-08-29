/**
 * Extracts the K/DST rows from a FantasyPros draft export.
 *
 * The full export is not published: only the two positions this product is
 * entitled to use, which is also the only part it reads. Mapping to Sleeper ids
 * deliberately does NOT happen here - that needs the live player universe, so
 * it happens in the browser against the same map the draft board uses.
 *
 *   node scripts/build-supplemental-rankings.mjs [csv] [out]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const source =
  process.argv[2] ?? join(root, 'data', 'rankings', 'fantasypros-2026-draft-all.csv');
const target =
  process.argv[3] ?? join(root, 'public', 'fantasy-pros-kdst-2026.json');

const { parseFantasyProsRankings } = await import(
  join(root, 'scripts', 'parse-supplemental.mjs')
);

const rows = parseFantasyProsRankings(readFileSync(source, 'utf8'));
const payload = {
  season: '2026',
  provenance: {
    sourceId: 'fantasy-pros-draft-rankings',
    sourceLabel: 'FantasyPros expert consensus',
    season: '2026',
    fetchedAt: new Date().toISOString(),
    sourceUpdatedAt: null,
    sourceConfidence: 'medium',
    attributionLabel: 'FantasyPros',
    attributionUrl: 'https://www.fantasypros.com/nfl/rankings/',
  },
  rows,
};

writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`Wrote ${rows.length} K/DST rows to ${target}`);
