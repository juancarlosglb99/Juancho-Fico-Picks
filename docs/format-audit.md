# Recommendation Engine Format Audit

Audited baseline: commit `63a6730`.

## Assumptions found in the previous engine

1. The recommendation function accepted raw Sleeper draft settings and had no
   normalized league model.
2. Every league was effectively treated as current-season redraft.
3. Dynasty startup, dynasty rookie/supplemental, and keeper drafts shared the
   same valuation objective.
4. Superflex was represented by a small fractional demand adjustment instead
   of replacement level derived from the complete roster structure.
5. League scoring was displayed but did not change projected points or value.
6. Aggregate fantasy-point projections were treated as though they matched the
   imported league's scoring rules.
7. ADP was treated as format-neutral and next-pick percentages were displayed
   without source compatibility or confidence.
8. Next-pick sequencing handled ordinary snake drafts but not 3RR, auction, or
   traded-pick ownership.
9. Best Ball was not detected, so classic weekly roster-fit assumptions could
   be applied.
10. Bench depth, taxi, IR, flex aliases, IDP slots, and unknown roster positions
    were not represented in replacement assumptions.
11. Keeper markers were removed from availability only incidentally as normal
    picks; the model did not expose keeper state or unknown keeper economics.
12. Multiple drafts in dynasty leagues did not affect draft-context detection.
13. The score details showed normalized factors but not raw inputs, replacement
    demand, scoring coverage, or detected league context.

## Hardening changes

- Added a first-class `LeagueContext`. Every derived context section retains a
  value, Sleeper/manual source, and confidence.
- Centralized Sleeper normalization for league type, draft context, draft
  order, lineup type, teams, roster construction, scoring, keeper settings,
  and current draft state.
- Added defensive handling for unknown Sleeper enums and manual overrides for
  league type, draft context, draft order, and lineup type.
- Added structural replacement demand from league size, direct starters,
  FLEX, SUPER_FLEX/2QB, and bench depth.
- Added 3RR sequencing, keeper markers, and current traded-pick ownership to
  the next-user-pick model.
- Added ADP format metadata and confidence. Missing or mismatched format ADP is
  labeled approximate and its score influence is reduced. League-size, keeper,
  Best Ball, unresolved-lineup, and custom-scoring differences also lower
  confidence even when the broad ADP format matches.
- Added optional granular stat columns. Complete stat lines are recalculated
  with actual Sleeper reception, passing, rushing, receiving, TE-premium, and
  fumble settings.
- Aggregate provider points remain unchanged. A declared reception format is
  accepted only when the rest of the league uses the baseline four-point-pass-TD
  scoring model; otherwise the aggregate remains explicitly unverified.
- Added a replaceable `DynastyValueProvider` contract. Redraft projections are
  blocked in dynasty instead of receiving a fabricated youth multiplier.
- Added `KeeperSettings` for detected and future/manual rule inputs. Current
  keeper advice is explicitly current-season-only while economics are unknown.
- Disabled turn-based recommendations for auction and neutralized roster-fit
  scoring for Best Ball or unresolved lineup type.
- Expanded the model inspector with raw, normalized, and contextual inputs.

## Support matrix

| Format | Level | Current behavior |
| --- | --- | --- |
| Classic redraft, snake/linear/3RR | Full when data matches | Current-season projection, dynamic VORP, scarcity, roster fit, ADP and next-pick value. |
| 1QB and Superflex/2QB redraft | Full for value; ADP-dependent probability | QB demand changes through replacement level. Format-matched ADP is required for high-confidence availability. |
| Standard, half-PPR, full-PPR | Full with compatible baseline aggregate source or granular stats | Complete granular projections are rescored; declared aggregate projections are accepted only when the remaining scoring coefficients match the baseline. |
| Custom scoring / TE premium | Partial to full | Core passing/rushing/receiving and position reception premiums are applied from complete stat lines. Two-point, threshold, and long-play bonuses need matching event-count projections. |
| Keeper | Partial | Detection, keeper picks, and current-season recommendations work. Keeper surplus is not modeled without league-specific costs. |
| Dynasty startup | Data required | Redraft rankings are blocked. A legitimate dynasty value provider is required. |
| Dynasty rookie/supplemental | Data required | Draft context is separated and redraft rankings are blocked. A rookie-capable dynasty provider is required. |
| Best Ball | Partial | Detected; classic roster-fit scoring is neutralized. Best Ball portfolio/volatility optimization is not implemented. |
| Auction | Unsupported optimizer | Detected; snake-specific advice is disabled. Budget and nomination modeling are not implemented. |
| IDP | Context only | Slots are normalized and shown, but IDP valuation is not implemented. |
| K/DEF | Limited | Eligible only in the final three rounds; custom unit scoring is not recalculated. |
| Unknown Sleeper formats | Manual review | Recommendations pause or become limited until the format is confirmed. |

## Data still required

- Licensed or internally modeled multi-year dynasty values, aging curves, and
  rookie values.
- League-specific keeper costs, penalties, escalation, retention limits, and
  auction prices.
- Format-specific ADP for high-confidence Superflex, dynasty, rookie, and other
  specialized next-pick estimates.
- Event-count projections for two-point, threshold, and long-play scoring bonuses.
- Auction values, budgets, nomination dynamics, and inflation.
- Best Ball correlation, volatility, and portfolio inputs.
- IDP projections and replacement models.

No format above is treated as fully supported when its required valuation or
source data is absent.
