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
4. **Draft scoring engine** — deterministic scoring anchored on what a player
   adds to a starting lineup, superseded in milestone 11 by roster-completion
   planning.
5. **Next-pick probability** — snake-draft turn detection plus draft-room rank,
   variance and positional-demand estimates for whether a player will make it
   back.
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
11. **Roster construction** — lineup-anchored value, positional saturation,
    roster-completion planning, emergent build classification, positional-run
    detection, opponent-roster-aware availability, and an autodraft acceptance
    harness that plays whole drafts on recommendation #1.
12. **Measured quality and speed** — a permanent regression corpus of real
    mocks pinned to the data they were drafted on, roster and decision quality
    scoring, and pick-to-advice latency measured against the live API.
13. **First Seed as the prior** — a consensus anchor tuned against the corpus, a
    per-pick deviation audit with named reasons, and a First-Seed-only control
    the strategy engine has to beat.

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

## Measuring whether it is any good

Two things decide whether this is worth using: the team you end up with, and how
quickly the advice reacts. Both are measured rather than asserted.

### Save every mock you draft

```bash
npm run capture -- "https://sleeper.com/draft/nfl/1234567890123456789" "yourusername"
```

That freezes the draft into `data/regression/mocks/` — the whole board, the
format, your seat, what the engine recommended and what its strategy state was
at every one of your selections, what you actually took, and the finished
roster. The First Seed projections, the Sleeper draft-room ranks and the player
pool are pinned alongside it, so the case replays identically in six weeks when
the weekly data has moved on. Snapshots are shared between drafts captured in
the same week rather than copied into each case.

Every saved mock is replayed by `npm test`. Each one has to field a legal
starting lineup, avoid hoarding a position it cannot start, produce no
unexplained contradictions, stay at least as good as the roster recorded when it
was captured, and answer every pick inside the compute budget. The suite prints
a line per case:

```text
[corpus] 1 saved mock
  1398412036827783168 seat 1 10-team standard: starting 1667.5 (+0 vs baseline) ·
  unfilled 0 · unusable 1 · meanRegret 4.5 · compute p50 6.1ms max 8.3ms ·
  RB6 WR4 QB2 TE1 K1 DEF1
```

`npm run test:regression` runs only the corpus.

### How far it may stray from First Seed

First Seed's draft-room ranking is the prior, not a suggestion. Reaching past it
costs something, and the cost grows with the distance reached, so a deviation
has to be worth it. The legitimate reasons are narrow and each one is named on
the pick that used it:

| Reason | Meaning |
| --- | --- |
| `positional_saturation` | The higher-ranked player cannot enter our lineup. |
| `starter_need` | Ours fills an empty starting slot; theirs does not. |
| `tier_cliff` | Our position is about to run out and theirs is not. |
| `returns_to_us` | The higher-ranked player is very likely to come back. |
| `opportunity_cost` | Completing the roster from ours is measurably better. |
| `higher_projection` | Same position and slot, and First Seed projects ours higher than the one it ranks above him. |

Anything else is the engine inventing its own board, and `npm test` fails on it.

**The simulation is the arbiter; heuristics only break ties.** A starter need or
a tier cliff is a reason to prefer a player when the completed-roster
simulation is close. It is not a reason to override it. A candidate beaten on
both counts — First Seed ranks the other player higher *and* our own simulation
finishes with a better roster from him — is dominated and cannot be recommended
above him, whatever heuristic applies.

The audit prints per pick, so an extreme override is obvious:

```text
R 8 p 80 │ FS# 71 Jayden Daniels  │ FS# 77 Tucker Kraft  │ gap 6 │ plan +10.0 ✓ │ starter_need
```

The live screen carries the same thing as a badge on every recommendation —
`FS 71 → 77 · +6` — amber past eight ranks and red past twenty-five.

### Beating the board

A strategy engine that loses to simply taking the best player available should
not be overriding anything, so the corpus runs both:

```bash
npm run test:regression   # audit + baseline comparison
npm run tune:consensus    # sweep the anchor weight against every saved mock
```

The anchor weight is chosen from that sweep rather than by taste, and the
comparison is part of the suite: if Juancho drops below the First Seed-only
baseline, the build fails.

Two captured mocks is a thin basis for a ranking rule, but each contains a whole
room. Every saved board is therefore replayed from **all ten or twelve seats**,
which keeps the data real while multiplying the situations the engine has to get
right — seat position changes who survives to your turn, how long you wait, and
whether you pick back-to-back:

```text
[seats] 20 seat-drafts across 2 real boards
[seats] mean +51.7 · better 10 · matched 10 · worse 0 · worst 0.0 · best 312.2
```

Worse on no seat is the bar. A recommendation that loses to simply taking the
best player available is the failure this engine keeps being reported for, so
the sweep optimizes the tail rather than the average.

### Reaction time

The live screen shows how long a pick takes to become advice, split into
noticing it and thinking about it, against a one-second budget. The same
measurement runs against the live API in `npm run test:smoke`:

| Part | Cost |
| --- | ---: |
| Poll interval | 800ms |
| Sleeper round trip | ~50ms |
| Rebuild board, context and every recommendation | ~15ms |
| **Typical pick to advice** | **~460ms** |
| Worst observed | ~870ms |

Rebuilding the recommendations is a rounding error next to waiting for the next
poll, so the polling interval is the budget. Traded picks are read every twenty
seconds instead of every poll — they almost never change, and a mock draft has
none — which leaves the request budget for the picks that actually move.

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

## Automatic ADP (reference only)

Market ADP is shown for context and is **not** part of the recommendation
decision path. Availability and value both read First Seed's Sleeper draft-room
rank, which describes the room you are actually drafting in; ADP from a
different format was a poor substitute and is no longer trusted with the
decision. It remains useful for spotting where the wider market disagrees with
your board.

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

Juancho does not rank players. It ranks **the roster you end up with**.

For each candidate it completes the draft from that pick — taking your
remaining selections in order while the room in front of you keeps taking the
consensus board — and scores the finished team. Points only count if they can
reach a starting lineup, so a second quarterback in a 1QB league is worth
roughly nothing no matter how many points he projects, while a fourth running
back still has a flex slot and an injury to walk into.

Several behaviours that would otherwise need their own rules fall out of this:

| Behaviour | Why it happens |
| --- | --- |
| Positional saturation | A player who cannot enter your lineup does not improve the finished roster. |
| Tier cliffs | If the last useful tight end goes before your next pick, every plan that waited inherits a worse one. |
| Opportunity cost | Spending a pick on a position you have costs whatever would have filled an empty slot. |
| Early-investment payoff | An elite quarterback in round 3 leaves nothing for a second one to improve. |

Bench value is discounted by how likely a player is to ever start. A position
with one starting slot can use exactly one backup; the third has no path into
the lineup in any week and is scored at zero.

### Draft now or wait

Both options are played out the same way, which is what makes the answer
trustworthy:

- **Take him now** — and the alternative either survives to your next pick or
  does not, weighted by how likely that is.
- **Wait** — take the alternative, and *he* either survives or does not.

Whichever finishes with the better roster is the recommendation. A player who is
coming back is never urgent, however good he is, and the headline pick never
tells you to wait on itself. When you pick back-to-back at the turn, nobody
selects in between and availability is reported as exactly 100%.

Availability is estimated from First Seed's Sleeper draft-room rank and from the
actual rosters of the teams picking before you: a quarterback is far likelier to
survive a stretch of teams that all already have one. Market ADP is displayed
for reference but does not drive recommendations.

The result is deterministic for a given draft state, normalized LeagueContext
and source snapshots. The score is decision support, not a promise of fantasy
results.

### Checking it still drafts well

The engine is held to one standard: if you follow recommendation #1 every round,
you should finish with a team you would have built yourself. `npm test` plays
complete drafts from early, middle and late seats across 10-team, 12-team and
Superflex leagues and fails if any required starting slot is left empty or any
position is hoarded. It also finishes drafts it did not choose to start —
RB-heavy, Zero-RB, Hero-RB, early TE, early QB — and benchmarks the result
against rank-only and need-then-rank baselines using the same roster evaluation.

## Structure

```text
app/                       Web application
packages/sleeper/          Public Sleeper API client, draft attachment and live sync
packages/players/          Canonical player model and external-ID indexes
packages/projections/      Replaceable projection-provider contracts and CSV
packages/adp/              Automatic ADP planning, providers and canonical mapping
packages/first-seed/       JuiceSheets, room-rank and signal providers/mapping
packages/data/             Snapshots, provenance, freshness and last-good cache
packages/engine/draft/     Lineup value, roster planning, strategy and recommendations
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
