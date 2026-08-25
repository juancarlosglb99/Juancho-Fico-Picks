# Juancho-Fico Picks

Sleeper-first fantasy football draft intelligence. The current product slice
connects a public Sleeper username, imports active-season leagues and rosters,
synchronizes draft picks, derives the available player pool, automatically loads
format-aware current ADP, and maps a persistent CSV projection source into
canonical Juancho-Fico player records.

## Included milestones

1. **League import** — username lookup, current leagues, settings, scoring and
   roster ownership.
2. **Draft synchronization** — draft selection, pick history, availability and
   five-second refresh while a draft is live.
3. **Projection mapping** — CSV provider, canonical player IDs, exact Sleeper-ID
   matching, normalized name/position matching and an unmatched-row review.
4. **Draft scoring engine** — normalized projection, VORP, scarcity, tier urgency,
   roster fit and ADP-value factors with a deterministic weighted score.
5. **Next-pick probability** — snake-draft turn detection plus ADP, variance and
   positional-demand estimates for whether a player will make it back.
6. **Draft Now / Wait recommendations** — live primary and alternative picks,
   transparent reasons, component scores and the next user selection.
7. **Format hardening** — normalized LeagueContext, Superflex/2QB replacement,
   3RR and traded picks, scoring-aware stat lines, confidence labels, honest
   dynasty/keeper/auction boundaries and a model inspector.
8. **Production data and draft UX** — current 2026 Fantasy Football Calculator
   ADP, source provenance, league-format compatibility, freshness, last-known-good
   caching, canonical match coverage, a compact data-quality view, and a
   recommendation-first live draft screen.

Lineup, waiver, trade, browser-extension and AI explanation features remain
future milestones. See [the format audit](docs/format-audit.md) for the exact
support matrix and [the data-source audit](docs/data-sources.md) for source,
licensing, freshness, and fallback decisions.

## Development

```bash
npm install
npm run dev
```

Quality checks:

```bash
npm test
npm run test:smoke
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
available. Optional `adp_format` and `projection_scoring` columns declare source
compatibility. Optional `pass_yd`, `pass_td`, `pass_int`, `rush_yd`, `rush_td`,
`rec`, `rec_yd`, `rec_td`, and `fum_lost` columns let the engine recalculate a
complete position-relevant stat line with the imported league's scoring. Blank
position-relevant values are treated as incomplete, not zero. See
`data/projections/example.csv` for an example.

The app also exposes a downloadable starter file at
`/projection-template.csv`.

The latest valid projection import is stored locally by season and restored on
the same browser, so a user does not need to repeat the import for every draft
session. A failed replacement import never clears the last valid snapshot.

## Automatic ADP

Eligible redraft snake/linear/3RR leagues automatically request current ADP
through the server-side `/api/adp` route. The provider is Fantasy Football
Calculator, with explicit attribution in the UI. Standard, half-PPR, PPR, and
2QB data are selected from the league context; 8/10/12/14-team datasets are
supported, with the nearest size visibly labeled approximate when necessary.

The route is CDN-cacheable for six hours. The browser refreshes a snapshot no
more than every 12 hours unless the user retries, validates it before storage,
and falls back to the last valid snapshot on upstream failure. Source data older
than two days lowers confidence; data older than seven days is labeled stale and
weak. Automatic redraft ADP is not applied to dynasty or auction drafts.

## Draft score

Every factor is normalized to a 0–100 scale before weighting:

| Factor | Weight |
| --- | ---: |
| Value over replacement (VORP) | 30% |
| Risk the player is gone by the next pick | 20% |
| Tier urgency | 15% |
| Raw projection | 15% |
| Roster fit | 10% |
| ADP value | 5% |
| Positional scarcity | 5% |

The result is deterministic for a given draft state, normalized LeagueContext,
and projection file. Low-confidence or format-mismatched ADP is downweighted.
The score is decision support, not a promise of fantasy results.

## Structure

```text
app/                       Web application
packages/sleeper/          Public Sleeper API client and normalization
packages/players/          Canonical player model and external-ID indexes
packages/projections/      Replaceable projection-provider contracts and CSV
packages/adp/              Automatic ADP planning, providers and canonical mapping
packages/data/             Snapshots, provenance, freshness and last-good cache
packages/engine/draft/     Draft state, availability, tiers and recommendations
packages/engine/context/   Sleeper normalization and league scoring
packages/dynasty/          Replaceable dynasty value-provider contract
tests/                     Deterministic unit tests
```

Sleeper access is read-only and requires no password or token. The official API
is free for non-commercial use; contact Sleeper before commercializing an app
that depends on it. Fantasy Football Calculator documents its ADP API as free
for personal and commercial use and requests attribution. See
`docs/data-sources.md` before changing or adding a provider.
