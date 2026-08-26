# Mock Draft and Monte Carlo Model

Model versions:

- Opponents: `market-opponent-2026.1`
- Draft continuation / Monte Carlo: `draft-continuation-2026.1`

## Inputs and boundaries

The production mock stack uses First Seed aggregate projections, Fantasy
Football Calculator market ADP, First Seed's platform-specific Sleeper room
rank, normalized `LeagueContext`, the current draft board, and every roster's
position counts. Juancho-Fico projection rank is used for the user's decision
objective, never as the opponent baseline.

Each opposing roster receives a stable archetype: room-rank follower, market
follower, roster builder, positional runner, or balanced. Pick logits combine
room timing, ADP timing, roster need, recent positional runs, Superflex QB demand,
and seeded randomness. A softmax draw among plausible candidates prevents mocks
from becoming a deterministic copy of room order.

## Candidate comparison

The UI runs 60 complete continuations per top candidate. A candidate is forced
at the current decision only for final-roster outcome scoring. A separate
withhold simulation estimates whether that candidate survives to the next user
selection, avoiding the circular error of counting the forced current pick as
unavailable. Results expose average roster score, 25th/75th percentiles, and the
empirical next-pick survival rate.

Final-roster scoring values the best projected starters, gives a small depth
credit, and penalizes unfilled starter slots. It is a comparative draft objective,
not a calibrated season-win probability.

## Reproducibility and backtesting

All simulations accept a seed. `runDraftBacktest` records the model recommendation,
the actual historical selection when supplied, whether they matched, and the full
candidate comparison. This provides a stable seam for adding held-out completed
drafts and richer outcome metrics later.

Current unit coverage includes heterogeneous archetypes, platform-rank influence,
deterministic 1QB and Superflex continuations, empirical wait availability,
complete-roster comparisons, and versioned backtest output.
