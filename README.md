# Juancho-Fico Picks

Sleeper-first fantasy football draft intelligence. The current product slice
connects a public Sleeper username, imports active-season leagues and rosters,
synchronizes draft picks, derives the available player pool, and automatically
loads First Seed projections, current market ADP, and Sleeper draft-room ranks.
CSV projections are an optional advanced override.

## Included milestones

1. **League import** — username lookup, current leagues, settings, scoring and
   roster ownership.
2. **Draft synchronization** — draft selection, pick history, availability and
   automatic pick-by-pick sync while a draft is live.
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
9. **First Seed automatic data** — weekly JuiceSheets aggregate projections and
   platform-specific Abusing Draft Rankings snapshots with independent
   provenance, format selection, canonical mapping, and last-known-good caches.
10. **Mock Draft / Monte Carlo** — deterministic model versions, heterogeneous
    opponent archetypes, probabilistic room-rank/market/need behavior, complete
    draft continuations, candidate comparisons, wait probabilities, and
    final-roster outcome scoring.

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

## Attaching to a mock or live draft

Juancho follows any Sleeper draft, whether or not it belongs to a league.

Two ways to attach:

1. **Pick a discovered draft.** After connecting your username, the *Follow a
   draft* panel lists your active and upcoming drafts, mock drafts included.
   Mocks have no league, so they never appear in the league dropdown; they are
   read from `/user/{user_id}/drafts/nfl/{season}`.
2. **Paste the draft link.** Open the Sleeper draft room and copy the address,
   e.g. `https://sleeper.com/draft/nfl/1234567890123456789`. A bare draft ID, a
   `sleeper.app` link, and a link with extra path or query segments all work.
   This route always works, even when discovery cannot see the draft.

Once attached, the banner at the top of the screen names the draft, its format,
and its draft ID, and shows a live status:

| Status | Meaning |
| --- | --- |
| **Watching** | Attached before the first pick. The room is still `pre_draft`; picks appear the moment it goes live. |
| **Live · auto-syncing** | Following the draft. Every pick updates the board, your roster, the current and next pick, availability probabilities, and the recommendations. |
| **Reconnecting** | A request to Sleeper failed. The last known board stays on screen while the sync retries with exponential backoff. |
| **Draft complete** | The draft finished and polling stopped on purpose. |

There is no refresh step. *Sync now* exists only to force an immediate poll.

Synchronization cadence is 2.5s while drafting, 10s before the draft starts, and
4x slower in a background tab, all with jitter. Failures back off exponentially
from 2s to a 30s ceiling and never clear the board or raise a page-level error.
Returning to the tab, or the machine coming back online, triggers an immediate
resync.

Mock drafts and league drafts use the identical engine path. A mock has no
league object, so the league and rosters are synthesized from the draft room's
own settings and `draft_order`. Nothing is invented silently: roster slots and
scoring are read from `draft.settings`, the normalized context labels that source
honestly, and the attach banner lists everything that was inferred.

## Automatic projections and room order

Supported redraft and keeper snake/linear/3RR leagues automatically select
First Seed JuiceSheets Standard, Half-PPR, or PPR aggregate projections. Sleeper
mock opponents also receive the matching Sleeper draft-room order, including the
dedicated Superflex tab. The two datasets refresh at most every four days in the
browser, are validated before persistence, and fall back to the last valid
snapshot after a transient or malformed refresh.

Projection, market ADP, platform room rank, First Seed value/expert fields, and
Juancho-Fico rank remain independent. They are never averaged into one opaque
ranking. Selected projection and draft-room data are attributed to
[First Seed Sports](https://firstseedsports.com/).

## Optional projection CSV override

Required columns:

```csv
player,position,projection
Nico Collins,WR,245.7
```

An optional `sleeper_id` column produces an exact match and is preferred when
available. Legacy `rank` and `adp` columns are accepted but do not override
Juancho-Fico rank or automatic market ADP. Optional `projection_scoring` declares
source compatibility. Optional `pass_yd`, `pass_td`, `pass_int`, `rush_yd`, `rush_td`,
`rec`, `rec_yd`, `rec_td`, and `fum_lost` columns let the engine recalculate a
complete position-relevant stat line with the imported league's scoring. Blank
position-relevant values are treated as incomplete, not zero. See
`data/projections/example.csv` for an example.

The app also exposes a downloadable starter file at
`/projection-template.csv`.

The latest valid custom override is stored locally by season and restored on
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

The live recommendation result is deterministic for a given draft state,
normalized LeagueContext, and source snapshots. Low-confidence or
format-mismatched ADP is downweighted.
The score is decision support, not a promise of fantasy results.

## Structure

```text
app/                       Web application
packages/sleeper/          Public Sleeper API client, draft attachment and live sync
packages/players/          Canonical player model and external-ID indexes
packages/projections/      Replaceable projection-provider contracts and CSV
packages/adp/              Automatic ADP planning, providers and canonical mapping
packages/first-seed/       JuiceSheets, room-rank and signal providers/mapping
packages/data/             Snapshots, provenance, freshness and last-good cache
packages/engine/draft/     Draft state, availability, tiers and recommendations
packages/engine/mock/      Opponent behavior, Monte Carlo, and backtesting
packages/engine/context/   Sleeper normalization and league scoring
packages/dynasty/          Replaceable dynasty value-provider contract
tests/                     Deterministic unit tests
```

Sleeper access is read-only and requires no password or token. The official API
is free for non-commercial use; contact Sleeper before commercializing an app
that depends on it. Fantasy Football Calculator documents its ADP API as free
for personal and commercial use and requests attribution. See
`docs/data-sources.md` before changing or adding a provider.
