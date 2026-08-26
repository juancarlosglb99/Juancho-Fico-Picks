# Projection and Ranking Semantics

Juancho-Fico keeps these concepts independent:

| Concept | Production source | Use |
| --- | --- | --- |
| Projection | First Seed JuiceSheets aggregate points | League-format player value and VORP |
| Juancho-Fico rank | Derived by the recommendation engine | Ordering under the selected league context |
| Market ADP | Fantasy Football Calculator | Market cost and availability |
| Draft-room rank | First Seed platform sheet (Sleeper in production) | What opponents see in the room |
| External expert/value fields | Labeled columns retained from First Seed | Inspectable external signal only |
| Simulation return probability | Monte Carlo continuations | Empirical chance a player survives to the next pick |

None of these is silently substituted for another or averaged into one rank.
CSV overrides replace only projection input. Their legacy `rank` and `adp`
columns are accepted for compatibility but ignored by automatic rank and ADP
systems.

JuiceSheets provides aggregate fantasy totals, not granular statistical lines.
Standard, Half-PPR, and PPR are selected directly. Custom scoring uses the
nearest reception format with a visible limited-compatibility warning; aggregate
points are not presented as perfectly recalculated custom projections.
