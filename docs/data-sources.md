# Data Source Audit

Audit date: August 26, 2026. This document records the upstream material checked
for the production data-layer milestone. A repository or API being technically
accessible is not treated as permission to reuse its data.

## Decision summary

| Source | Data | Juancho-Fico decision |
| --- | --- | --- |
| First Seed Sports | Aggregate projections, platform draft-room rankings, and weekly context | **Accepted and implemented** under direct private permission for this private personal-use app, with attribution. |
| Fantasy Football Calculator | Current and historical ADP | **Accepted and implemented** for automatic redraft ADP. |
| Sleeper API | League, draft, roster, pick and canonical player identity data | **Retained** for read-only league context and live draft state. |
| User-supplied CSV | Optional custom projections | **Retained as an advanced override**; rank and ADP are not required and do not override automatic systems. |
| MyFantasyLeague | Public ADP export | **Rejected** without written permission because current terms prohibit copying, caching, extraction, and commercial reuse. |
| nflverse-data | Historical NFL datasets | **Rejected as a projection provider**; it does not supply ready-to-use forward 2026 fantasy projections and upstream ownership still matters. |
| ffverse/ffsimulator | Open-source simulation framework | **Rejected as a data provider**; it is a model/tooling framework that still requires legitimate projection inputs. |
| DynastyProcess data | Aggregated dynasty/redraft ranking data | **Rejected** because an open repository license does not establish reusable rights to every upstream ranking source. |
| Fantasy Football Draft MCP | Community projection/model server | **Rejected for production** pending independent model validation and clarification of all upstream input rights. |
| Proprietary ranking/projection sites named in the milestone | Projections, rankings, ADP or dynasty values | **Not accessed or scraped**; no provider was implemented without explicit reuse rights. |

## Selected sources

### First Seed Sports

- **Permission status:** direct private permission obtained from First Seed.
- **Permitted use:** use of First Seed material in Juancho-Fico Picks.
- **Attribution requirement:** First Seed must be referenced.
- **Evidence:** permission retained privately by project owner.
- **Date permission confirmed:** August 26, 2026.
- **Current scope:** this is a private personal-use tool and is not currently sold
  or distributed commercially. Reassess permission before materially changing
  that scope.
- **Evidence privacy:** the private permission conversation is not published in
  this repository.
- **Provenance boundary:** permission applies to First Seed-provided material. It
  is not represented as an independent license from FantasyPros, ESPN, Yahoo,
  BeatADP, CBS, Sleeper, or any other upstream source named inside First Seed
  workbooks. Juancho-Fico attributes the normalized datasets to First Seed and
  retains upstream-labeled columns only as distinct provenance fields.
- **Projection source:** [JuiceSheets](https://docs.google.com/spreadsheets/d/199izMhbkOOjTsNmrK-D56dYnnViJBYFfBEtxK268h4Y/edit),
  structured `gviz` CSV access, `Combined` plus `Introduction`. The provider
  selects `Proj Std`, `Proj Half`, or `Proj PPR`; it does not invent granular
  stats. The live Aug. 26 audit parsed 213 records and detected Aug. 13, 2026 as
  the workbook update date.
- **Draft-room source:** [Abusing Draft Rankings 2026](https://docs.google.com/spreadsheets/d/1HTixsrRtIIpnUafVkOIhET83vCFjKXSUGiG24-5jTHY/edit),
  structured `gviz` CSV access. Production selects `Sleeper Standard`, `Sleeper
  Half PPR`, `Sleeper PPR`, or `Sleeper Superflex`; adapters support the workbook's
  ESPN, Yahoo, and CBS tabs as distinct platform contexts. The live Aug. 26 audit
  parsed 200 Sleeper PPR records and detected Aug. 20, 2026 as the update date.
- **Fields:** player, position, team, aggregate projection, platform room rank,
  upstream market ADP, upstream expert rank, First Seed value delta, and landmine
  score when present. These fields remain separate.
- **Refresh/failure behavior:** the browser refresh interval is four days to
  respect the weekly publishing cadence; route responses are shared-cacheable
  for twelve hours. Minimum row counts, required headers, numeric validation,
  and snapshot validation prevent malformed or truncated refreshes from replacing
  the last-known-good cache.
- **Attribution:** the Data Quality source details link to First Seed Sports.
- **Signals:** `PlayerSignalProvider` and `FirstSeedSignalProvider` contracts are
  present for structured injury/role/mover context. Newsletter prose is not
  automatically converted into projection adjustments.

### Fantasy Football Calculator ADP REST API

- **Upstream:** [official ADP REST API documentation](https://help.fantasyfootballcalculator.com/article/42-adp-rest-api)
- **Data:** player ADP, rank/order, position, team, drafts sampled per player,
  standard deviation, total sample size, and source date range.
- **Current availability:** live 2026 responses were verified on August 25,
  2026 for `standard`, `half-ppr`, `ppr`, and `2qb` with 12 teams. Live checks
  also verified 8, 10, 12, and 14 as accepted team counts.
- **Update frequency:** the official documentation says the data updates once
  per day.
- **Formats:** standard, half-PPR, PPR, and 2QB endpoints. Standard/half/PPR are
  modeled as redraft 1QB. The 2QB endpoint is modeled as redraft Superflex/2QB,
  but its reception scoring is `unknown` because the source does not declare it.
  No dynasty, startup, or rookie snapshot is used.
- **Access:** JSON REST endpoint under
  `https://fantasyfootballcalculator.com/api/v1/adp/{format}` with `teams` and
  `year` parameters. Juancho-Fico accesses it only through `/api/adp`, avoiding
  client CORS dependence.
- **Permission/commercial status:** the official documentation explicitly says
  the API is free for personal and commercial use.
- **Attribution:** the provider requests a link or mention. The Data Quality
  panel links to Fantasy Football Calculator.
- **Request restriction:** the source asks clients not to call too frequently
  because data changes daily. Juancho-Fico applies a six-hour shared/CDN cache
  and a twelve-hour browser refresh interval; a manual retry can force a refresh.
- **Validation:** a snapshot must report success, match the requested team size,
  contain at least 80 valid players, and stay within the invalid-row tolerance.
  Empty, partial, malformed, wrong-size, and excessive-invalid-row responses are
  rejected before the last-good cache can be replaced.
- **Compatibility:** exact only when team count, quarterback format, broad
  reception scoring, league type, lineup type, and freshness support that label.
  Nearest-size/custom/keeper matches are approximate. QB-format, material
  scoring, Best Ball/unknown-lineup, or stale mismatches are weak.

### Sleeper API

- **Upstream:** [official Sleeper API documentation](https://docs.sleeper.com/)
- **Data:** user lookup, active season, leagues, scoring and roster settings,
  owners, rosters, drafts, picks, traded picks, and the NFL player directory.
- **Update frequency:** draft state is refreshed every five seconds only while
  a selected draft reports `drafting`; slow-moving ADP uses its own cache.
- **Formats:** Sleeper is the league-context source rather than a valuation
  source. Juancho-Fico normalizes redraft/keeper/dynasty, snake/linear/3RR/
  auction, roster slots, PPR variants, custom scoring, and draft state.
- **Access:** unauthenticated read-only HTTP API.
- **Permission/commercial status:** the official documentation says the API is
  free for non-commercial use and instructs commercial users to contact Sleeper
  for licensing. This app must not be represented as commercially licensed.
- **Request restriction:** Sleeper gives a general guideline of fewer than 1,000
  API calls per minute. The app's scoped live refresh remains far below that.
- **Use:** accepted for the present non-commercial product slice. It is the
  canonical identity source; provider IDs never enter the engine directly.

### User-supplied projection CSV

- **Data:** player name/ID, position, aggregate projection, optional legacy ADP/rank, optional
  format declarations, and optional position-relevant statistical projections.
- **Update frequency:** controlled by the file owner. The import timestamp is
  stored as `fetchedAt`; no source update date is invented.
- **Formats:** `adp_format` can declare redraft 1QB, redraft Superflex, dynasty
  startup, dynasty rookie, or unknown. `projection_scoring` can declare a broad
  scoring profile. Complete statistical lines are recalculated against Sleeper
  scoring; aggregate-only points are not called custom-scoring compatible.
- **Access/rights:** local file import. The user is responsible for having the
  right to use the file. Juancho-Fico does not redistribute the input.
- **Use:** accepted only as a custom projection override. The minimum schema is
  `player,position,projection`. Imported rank and ADP never replace Juancho-Fico
  rank or automatic FFC ADP. The latest valid season snapshot persists locally;
  a bad replacement import does not clear it.
- **Confidence:** medium for a non-empty mapped projection snapshot. Aggregate
  projection compatibility remains limited when source scoring is undeclared.

## Sources evaluated but not selected

### MyFantasyLeague ADP export

- **Upstream:** [current MyFantasyLeague terms of service](https://home.myfantasyleague.com/terms.html)
- **Data/access:** a technically available season ADP export endpoint.
- **Frequency/formats:** the export exposes ADP records and request parameters,
  but technical availability was not treated as reuse permission.
- **Permission/commercial status:** the terms effective June 1, 2024 grant a
  personal, noncommercial display license and prohibit reproducing, publishing,
  distributing, copying, caching, scraping, data mining, and extraction without
  prior permission.
- **Decision:** rejected. Juancho-Fico does not request, cache, normalize, or
  display MFL ADP. Written permission would be required before reconsideration.

### nflverse-data

- **Upstream:** [nflverse-data repository](https://github.com/nflverse/nflverse-data)
- **Data/access:** downloadable historical play-by-play, roster, schedule, stats,
  and related NFL datasets produced by nflverse tooling.
- **Licensing:** repository licensing does not override ownership or usage terms
  of underlying data sources.
- **Decision:** not a current-season fantasy projection feed. Building a new
  projection model from legitimately reusable inputs is a possible future
  milestone, but this repository alone does not satisfy the present requirement.

### ffverse/ffsimulator

- **Upstream:** [ffsimulator repository](https://github.com/ffverse/ffsimulator)
- **Data/access:** open-source fantasy season simulation code that consumes
  projection and league inputs.
- **Licensing:** its code license applies to the framework; input datasets retain
  their own ownership and terms.
- **Decision:** useful future modeling infrastructure, but not a licensed,
  maintained 2026 projection source by itself.

### DynastyProcess data

- **Upstream:** [DynastyProcess data repository](https://github.com/dynastyprocess/data)
- **Data/access:** community datasets and aggregated ranking/ECR artifacts.
- **Licensing:** the repository is open, but some artifacts derive from third-
  party ranking sources. The repository license is not sufficient evidence that
  Juancho-Fico may commercially reproduce all underlying rankings.
- **Decision:** rejected for automatic projections/ADP. No FantasyPros-derived
  ranking or ECR data is shipped or fetched.

### Fantasy Football Draft MCP

- **Upstream:** [community repository](https://github.com/zacharytran26/Fantasy-Football-Draft-MCP)
- **Data/access:** an open model/server approach that describes projections from
  open data and historical ranking inputs.
- **Licensing/validation:** the code is openly licensed, but production quality,
  calibration, maintenance, and rights for all historical upstream ranking inputs
  were not sufficiently established in this audit.
- **Decision:** rejected for automatic production use. A future internally
  validated model would need documented inputs, reproducible calibration, and
  evaluation against held-out seasons.

### Explicitly excluded proprietary sources

FantasyPros, WalterPicks, KeepTradeCut, Draft Sharks, Footballguys, ESPN,
sportsbooks, and similar proprietary services are not accessed directly,
scraped, reverse-engineered, or represented as independently licensed. Labeled
upstream comparison fields that First Seed publishes inside its permitted
workbooks remain attributed to First Seed and are kept as distinct provenance,
not promoted to first-party provider feeds.

## Normalization, coverage, and failure behavior

Every source snapshot retains source ID/label, season, fetch time, source update
time when available, source confidence, and its format context. Automatic ADP
and First Seed room rankings are resolved into the Sleeper-backed canonical map
by this order:

1. supplied Sleeper/external ID;
2. canonical team code for defenses;
3. normalized name plus position when unique;
4. normalized name when globally unique.

Ambiguous matches are never chosen. Ambiguous and unresolved rows stay in the
snapshot's review counts. Direct-ID, exact canonical, normalized-unique,
ambiguous, and unresolved totals are displayed in the expanded Data Quality
view.

The live August 26, 2026 audit resolved 213/213 First Seed PPR projection rows
and 200/200 First Seed Sleeper PPR room rows. The prior FFC audit
resolved 221/221 standard, 231/231 half-PPR, 270/270 PPR, and 244/244 2QB FFC
rows. These are point-in-time results, not a guarantee of future coverage; each
new snapshot calculates and exposes its own resolution summary.

The browser stores a versioned last-known-good envelope. A refresh is written
only after full provider validation. On request failure or invalid/empty/partial
data, the valid cache remains untouched and is used with a visible refresh
warning. Freshness is based on `sourceUpdatedAt` when present, otherwise
`fetchedAt`: up to two days is fresh, more than two through seven days is aging,
and more than seven days is stale. Aging lowers high confidence to medium; stale
data is weak/low confidence.

Projection and ADP consensus interfaces exist for future multi-source
composition, but Juancho-Fico does not average sources. The engine receives only
normalized projection records with retained per-field provenance and confidence.
