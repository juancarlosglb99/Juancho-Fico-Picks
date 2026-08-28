'use client';

/**
 * The developer's view of the machine, kept out of the product.
 *
 * Everything here used to be on the main screen: source provenance, match
 * rates, the model inspector, reaction-time percentiles. All of it is worth
 * having and none of it is worth a drafter's attention with a clock running, so
 * it lives behind one disclosure that only opens in development or when
 * `?diagnostics=1` is asked for explicitly.
 */
import type {
  AdpSnapshot,
  DraftRoomRankingSnapshot,
  ProjectionSnapshot,
} from '@/packages/data/types';
import type { LeagueContext } from '@/packages/engine/context/types';
import type { DraftRecommendation } from '@/packages/engine/draft/types';
import type { LatencySummary } from '@/packages/engine/perf/latency';
import type { SyncState } from '@/packages/sleeper/live-sync';
import { formatDataAge, sourceAgeMs } from '@/packages/data/freshness';
import { displayEnum, formatPoints } from '@/packages/ui/theme';

export function diagnosticsEnabled(search: string): boolean {
  if (process.env.NODE_ENV !== 'production') return true;
  return new URLSearchParams(search).get('diagnostics') === '1';
}

export function DiagnosticsPanel({
  projections,
  roomRankings,
  adp,
  context,
  recommendation,
  latency,
  syncState,
  onRetrySources,
  onImportCsv,
  onRestoreAutomatic,
  usingCustomProjections,
  account,
}: {
  projections: ProjectionSnapshot | null;
  roomRankings: DraftRoomRankingSnapshot | null;
  adp: AdpSnapshot | null;
  context: LeagueContext | null;
  recommendation: DraftRecommendation | null;
  latency: LatencySummary | null;
  syncState: SyncState;
  onRetrySources: () => void;
  onImportCsv: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onRestoreAutomatic: () => void;
  usingCustomProjections: boolean;
  /** What the SERVER said. A refusal now has two quite different causes. */
  account?: {
    accountsEnabled: boolean;
    signedIn: boolean;
    plan: string;
    creditsRemaining: number | null;
  } | null;
}) {
  return (
    <details className="rounded-2xl border border-[#1a2830] bg-[#08121a] p-3">
      <summary className="cursor-pointer text-[10px] font-black uppercase tracking-[0.14em] text-[#4d5f6b]">
        Diagnostics · development only
      </summary>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <Card title="Data sources">
          <SourceRow
            label="First Seed projections"
            detail={
              projections
                ? `${projections.resolution.matched}/${projections.resolution.total} matched · ${projections.unmatched.length} unmatched`
                : 'not loaded'
            }
            age={projections ? formatDataAge(sourceAgeMs(projections.provenance)) : null}
            source={projections?.provenance.sourceLabel ?? null}
          />
          <SourceRow
            label="Sleeper draft-room ranks"
            detail={
              roomRankings
                ? `${roomRankings.records.length} ranked · ${roomRankings.compatibility.level}`
                : 'not loaded'
            }
            age={roomRankings ? formatDataAge(sourceAgeMs(roomRankings.provenance)) : null}
            source={roomRankings?.context.sheet ?? null}
          />
          <SourceRow
            label="Market ADP"
            detail={adp ? `${adp.context.teams}-team · ${adp.compatibility.level}` : 'not loaded'}
            age={adp ? formatDataAge(sourceAgeMs(adp.provenance)) : null}
            source={adp?.provenance.sourceLabel ?? null}
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={onRetrySources}
              className="rounded-lg border border-[#25373f] px-2.5 py-1.5 text-[10px] font-black uppercase tracking-[0.08em] text-[#8fa0aa] hover:border-[#3d525f]"
            >
              Refetch sources
            </button>
            <label className="cursor-pointer rounded-lg border border-[#25373f] px-2.5 py-1.5 text-[10px] font-black uppercase tracking-[0.08em] text-[#8fa0aa] hover:border-[#3d525f]">
              Custom CSV
              <input type="file" accept=".csv,text/csv" className="sr-only" onChange={onImportCsv} />
            </label>
            {usingCustomProjections && (
              <button
                onClick={onRestoreAutomatic}
                className="rounded-lg border border-[#25373f] px-2.5 py-1.5 text-[10px] font-black uppercase tracking-[0.08em] text-[#8fa0aa] hover:border-[#3d525f]"
              >
                Restore automatic
              </button>
            )}
          </div>
        </Card>

        <Card title="Reaction time and sync">
          {latency && latency.total.count > 0 ? (
            <dl className="grid grid-cols-2 gap-2">
              <Row label="Pick to advice, median" value={formatMs(latency.total.p50Ms)} />
              <Row label="p95" value={formatMs(latency.total.p95Ms)} />
              <Row label="Noticing" value={formatMs(latency.detection.p50Ms)} />
              <Row label="Thinking" value={formatMs(latency.compute.p50Ms)} />
              <Row
                label={`Under ${latency.budgetMs / 1000}s`}
                value={latency.withinBudget === null ? '—' : `${latency.withinBudget}%`}
              />
              <Row label="Samples" value={String(latency.samples)} />
            </dl>
          ) : (
            <p className="text-[11px] text-[#5f7280]">No picks measured yet.</p>
          )}
          <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-[#16242d] pt-3">
            <Row label="Sync phase" value={syncState.phase} />
            <Row label="Successes" value={String(syncState.successCount)} />
            <Row label="Failures in a row" value={String(syncState.consecutiveFailures)} />
            <Row label="Last error" value={syncState.lastError ?? 'none'} />
          </dl>
        </Card>

        {recommendation && (
          <Card title={`Model inspector · ${recommendation.player.name}`}>
            <dl className="grid grid-cols-2 gap-2">
              <Row label="Draft score" value={recommendation.score.toFixed(1)} />
              <Row label="Juancho rank" value={String(recommendation.juanchoRank)} />
              <Row label="First Seed rank" value={recommendation.draftRoomRank?.toFixed(0) ?? '—'} />
              <Row
                label="Reach past board"
                value={
                  recommendation.insight.firstSeedRankGap === null
                    ? '—'
                    : `${recommendation.insight.firstSeedRankGap} ranks`
                }
              />
              <Row label="Plan value" value={formatPoints(recommendation.components.planValue)} />
              <Row label="Plan vs best" value={formatPoints(recommendation.components.planDelta)} />
              <Row
                label="Adds to lineup"
                value={formatPoints(recommendation.components.marginalStartingValue)}
              />
              <Row label="Bench value" value={formatPoints(recommendation.components.depthValue)} />
              <Row
                label="Cost of waiting"
                value={formatPoints(recommendation.components.opportunityCost)}
              />
              <Row label="Next-pick risk" value={recommendation.components.nextPickRisk.toFixed(0)} />
              <Row label="Tier urgency" value={recommendation.components.tierUrgency.toFixed(0)} />
              <Row
                label="Saturation"
                value={recommendation.components.positionalSaturation.toFixed(0)}
              />
              <Row label="Build" value={displayEnum(recommendation.insight.build)} />
              <Row
                label="Expected final roster"
                value={formatPoints(recommendation.insight.expectedFinalRosterValue)}
              />
            </dl>
            {recommendation.insight.exceptionalReason && (
              <p className="mt-2 text-[11px] leading-5 text-[#e0a13c]">
                {recommendation.insight.exceptionalReason}
              </p>
            )}
          </Card>
        )}

        {account && (
          <Card title="Account and entitlement">
            <dl className="grid grid-cols-2 gap-2">
              <Row label="Accounts" value={account.accountsEnabled ? 'enabled' : 'not configured'} />
              <Row label="Signed in" value={account.signedIn ? 'yes' : 'no'} />
              <Row label="Plan" value={account.plan} />
              <Row
                label="AI drafts left"
                value={account.creditsRemaining === null ? 'unmetered' : String(account.creditsRemaining)}
              />
            </dl>
            <p className="mt-2 text-[11px] leading-5 text-[#5f7280]">
              Read from the server on every request. Editing anything here changes
              what this panel draws and nothing about what is authorised.
            </p>
          </Card>
        )}

        {context && (
          <Card title="League context">
            <dl className="grid grid-cols-2 gap-2">
              <Row label="League type" value={displayEnum(context.leagueType.value)} />
              <Row label="Draft type" value={displayEnum(context.draftType.value)} />
              <Row label="Lineup" value={displayEnum(context.lineupType.value)} />
              <Row label="Scoring" value={displayEnum(context.scoring.value.profile)} />
              <Row label="Teams" value={String(context.teams.value)} />
              <Row label="Our roster id" value={String(context.draftState.value.userRosterId)} />
            </dl>
            {context.warnings.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1">
                {context.warnings.map((warning) => (
                  <li key={warning} className="text-[11px] leading-5 text-[#e0a13c]">
                    · {warning}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>
    </details>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-[#16242d] bg-[#0a141c] p-3">
      <h3 className="mb-2.5 text-[10px] font-black uppercase tracking-[0.12em] text-[#5f7280]">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2 text-[11px]">
      <dt className="truncate text-[#5f7280]">{label}</dt>
      <dd className="shrink-0 font-bold tabular-nums text-[#a3b1ba]">{value}</dd>
    </div>
  );
}

function SourceRow({
  label,
  detail,
  age,
  source,
}: {
  label: string;
  detail: string;
  age: string | null;
  source: string | null;
}) {
  return (
    <div className="border-b border-[#16242d] py-1.5 last:border-b-0">
      <p className="flex justify-between gap-2 text-[11px]">
        <span className="font-bold text-[#a3b1ba]">{label}</span>
        <span className="shrink-0 text-[#5f7280]">{age ?? '—'}</span>
      </p>
      <p className="mt-0.5 truncate text-[10.5px] text-[#5f7280]">
        {detail}
        {source ? ` · ${source}` : ''}
      </p>
    </div>
  );
}

function formatMs(value: number | null): string {
  if (value === null) return '—';
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`;
}
