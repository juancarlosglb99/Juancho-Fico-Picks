# Juancho-Fico Picks

Sleeper-first fantasy football draft intelligence. The current product slice
connects a public Sleeper username, imports active-season leagues and rosters,
synchronizes draft picks, derives the available player pool, and maps a CSV
projection source into canonical Juancho-Fico player records.

## Included milestones

1. **League import** — username lookup, current leagues, settings, scoring and
   roster ownership.
2. **Draft synchronization** — draft selection, pick history, availability and
   five-second refresh while a draft is live.
3. **Projection mapping** — CSV provider, canonical player IDs, exact Sleeper-ID
   matching, normalized name/position matching and an unmatched-row review.

The recommendation algorithm, next-pick probability, extension and AI features
are intentionally deferred.

## Development

```bash
npm install
npm run dev
```

Quality checks:

```bash
npm test
npm run lint
npm run build
```

## Projection CSV

Required columns:

```csv
player,projection,adp,rank,position
Nico Collins,245.7,25.4,24,WR
```

An optional `sleeper_id` column produces an exact match and is preferred when
available. See `data/projections/example.csv` for a complete example.

## Structure

```text
app/                       Web application
packages/sleeper/          Public Sleeper API client and normalization
packages/players/          Canonical player model and external-ID indexes
packages/projections/      Replaceable projection-provider contracts and CSV
packages/engine/draft/     Draft state and player availability
tests/                     Deterministic unit tests
```

Sleeper access is read-only and requires no password or token. The official API
is free for non-commercial use; contact Sleeper before commercializing an app
that depends on it.
