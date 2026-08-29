'use client';

/**
 * The drawer's visualisations. Hand-drawn SVG and CSS, no chart library.
 *
 * The rule every one of these obeys: if the data is not there, the component
 * is not rendered. None of them fills a gap with a plausible shape - there is
 * no smoothed curve through two points, and no distribution drawn from a single
 * expected value. Where a number is uncertain the uncertainty is drawn too.
 */
import type { PeerComparison, ReplacementView, TierCliffView } from '@/packages/ui/player-analysis';
import { barDomain, barPercent } from '@/packages/ui/charts';
import {
  SURVIVAL_COLOR,
  formatPoints,
  formatSigned,
  positionPalette,
  survivalTone,
} from '@/packages/ui/theme';
import { Meter } from './primitives';

export function ChartFrame({
  title,
  caption,
  children,
}: {
  title: string;
  caption?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-[#1e2f3a] bg-[#0a141c] p-3.5">
      <h3 className="text-[10px] font-black uppercase tracking-[0.13em] text-[#71838e]">
        {title}
      </h3>
      {caption && <p className="mt-1 text-[11px] leading-5 text-[#5f7280]">{caption}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/* ------------------------------------------- A. projection against peers */

export function PeerChart({ peers }: { peers: PeerComparison }) {
  const domain = barDomain(peers.bars.map((bar) => bar.projectedPoints), {
    // Every player at a position projects hundreds of points, so anchoring at
    // zero would make nine bars of near-identical length. The comparison is the
    // point, so the axis is the range of these players.
    includeZero: false,
  });
  const palette = positionPalette(peers.position);

  return (
    <ChartFrame
      title={`Against other ${peers.position}s on the board`}
      caption={`${peers.position}${peers.subjectIndex} of ${peers.totalAtPosition} still available, by league-scored projection.`}
    >
      <ul className="flex flex-col gap-1.5">
        {peers.bars.map((bar) => (
          <li key={bar.playerId} className="grid grid-cols-[minmax(0,7.5rem)_1fr_3rem] items-center gap-2">
            <span
              className={`truncate text-[11px] ${
                bar.isSubject ? 'font-black text-white' : 'font-semibold text-[#7f919c]'
              }`}
            >
              {bar.name}
            </span>
            <Meter
              percent={Math.max(4, barPercent(bar.projectedPoints, domain))}
              color={bar.isSubject ? palette.fg : '#25404f'}
              height={10}
            />
            <span
              className={`text-right text-[11px] tabular-nums ${
                bar.isSubject ? 'font-black text-white' : 'font-bold text-[#5f7280]'
              }`}
            >
              {formatPoints(bar.projectedPoints)}
            </span>
          </li>
        ))}
      </ul>
    </ChartFrame>
  );
}

/* ---------------------------------------------------- B. replacement value */

export function ReplacementChart({ view }: { view: ReplacementView }) {
  const points = [view.subject.projectedPoints, view.replacement?.projectedPoints ?? 0];
  const gains = [view.subject.rosterGain ?? 0, view.replacement?.rosterGain ?? 0];
  const pointsDomain = barDomain(points);
  const gainDomain = barDomain(gains);

  return (
    <ChartFrame
      title="Him now, or his replacement later"
      caption={
        view.replacement
          ? `${view.replacement.name} is the best player at this position left on the board in ${Math.round(view.replacement.chanceBestOfPosition)}% of simulated futures.`
          : 'No likely replacement could be identified from the simulated futures.'
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="mb-2 text-[9px] font-black uppercase tracking-[0.12em] text-[#5f7280]">
            Raw projected points
          </p>
          <ComparisonPair
            a={{ label: view.subject.name, value: view.subject.projectedPoints }}
            b={
              view.replacement
                ? { label: view.replacement.name, value: view.replacement.projectedPoints }
                : null
            }
            domain={pointsDomain}
            color="#54a9f0"
          />
          {view.pointsDelta !== null && (
            <p className="mt-2 text-[11px] font-bold text-[#8fa0aa]">
              {formatSigned(view.pointsDelta)} points
            </p>
          )}
        </div>

        <div>
          <p className="mb-2 text-[9px] font-black uppercase tracking-[0.12em] text-[#5f7280]">
            Added to your roster
          </p>
          {view.subject.rosterGain === null ? (
            <p className="text-[11px] leading-5 text-[#5f7280]">
              Roster value is only computed for candidates the engine planned.
            </p>
          ) : (
            <ComparisonPair
              a={{ label: view.subject.name, value: view.subject.rosterGain }}
              b={
                view.replacement && view.replacement.rosterGain !== null
                  ? { label: view.replacement.name, value: view.replacement.rosterGain }
                  : null
              }
              domain={gainDomain}
              color="#b9ff38"
            />
          )}
          {view.rosterValueDelta !== null && (
            <p className="mt-2 text-[11px] font-bold text-[#b9ff38]">
              {formatSigned(view.rosterValueDelta)} to your roster
            </p>
          )}
        </div>
      </div>

      <p className="mt-3 border-t border-[#16242d] pt-2.5 text-[11px] leading-5 text-[#5f7280]">
        Roster value is not the player&apos;s projection: filling an empty starting
        slot is worth his points AND the end of the hole, so it can exceed them.
        {view.replacementLevel !== null &&
          ` Replacement level at this position is ${formatPoints(view.replacementLevel)} points.`}
      </p>
      {view.caveat && <p className="mt-2 text-[11px] leading-5 text-[#e0a13c]">{view.caveat}</p>}
    </ChartFrame>
  );
}

function ComparisonPair({
  a,
  b,
  domain,
  color,
}: {
  a: { label: string; value: number };
  b: { label: string; value: number } | null;
  domain: [number, number];
  color: string;
}) {
  return (
    <ul className="flex flex-col gap-2">
      {[a, b].filter(Boolean).map((entry, index) => (
        <li key={entry!.label}>
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-[11px] font-semibold text-[#c3d1d9]">{entry!.label}</span>
            <span className="shrink-0 text-[11px] font-black tabular-nums text-[#e2e8eb]">
              {formatPoints(entry!.value)}
            </span>
          </div>
          <div className="mt-1">
            <Meter
              percent={Math.max(3, barPercent(entry!.value, domain))}
              color={index === 0 ? color : '#25404f'}
              height={9}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------- D. tier cliff */

export function TierChart({ view }: { view: TierCliffView }) {
  const domain = barDomain(view.rows.map((row) => row.projectedPoints), { includeZero: false });
  return (
    <ChartFrame
      title={`Where the ${view.position} board falls away`}
      caption={
        view.gapAfterTier !== null
          ? `${formatPoints(view.gapAfterTier)} projected points separate tier ${view.subjectTier} from the one behind it.`
          : 'Tiers are derived by Juancho from First Seed’s projections.'
      }
    >
      <ul className="flex flex-col">
        {view.rows.map((row) => {
          const palette = positionPalette(view.position);
          return (
            <li key={row.playerId}>
              <div
                className={`grid grid-cols-[1.5rem_minmax(0,7rem)_1fr_2.6rem_2.6rem] items-center gap-2 rounded px-1 py-1 ${
                  row.isSubject ? 'bg-[#132029]' : ''
                }`}
              >
                <span className="text-[10px] font-bold tabular-nums text-[#4d5f6b]">
                  T{row.tier ?? '—'}
                </span>
                <span
                  className={`truncate text-[11px] ${
                    row.isSubject ? 'font-black text-white' : 'font-semibold text-[#7f919c]'
                  }`}
                >
                  {row.name}
                </span>
                <Meter
                  percent={Math.max(4, barPercent(row.projectedPoints, domain))}
                  color={row.isSubject ? palette.fg : '#25404f'}
                  height={8}
                />
                <span className="text-right text-[10px] font-bold tabular-nums text-[#8fa0aa]">
                  {formatPoints(row.projectedPoints)}
                </span>
                <span
                  className="text-right text-[10px] font-bold tabular-nums"
                  style={{ color: SURVIVAL_COLOR[survivalTone(row.survival)] }}
                >
                  {row.survival === null ? '—' : `${Math.round(row.survival)}%`}
                </span>
              </div>
              {row.cliffAfter && (
                <div className="my-1 flex items-center gap-2 px-1">
                  <span className="h-px flex-1 bg-[#e0a13c]/40" />
                  <span className="text-[9px] font-black uppercase tracking-[0.1em] text-[#e0a13c]">
                    tier break
                  </span>
                  <span className="h-px flex-1 bg-[#e0a13c]/40" />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {view.tierSurvives !== null && (
        <p className="mt-3 text-[11px] leading-5 text-[#8fa0aa]">
          The tier still holds at least one player at your next selection in{' '}
          <span className="font-black text-[#e2e8eb]">{Math.round(view.tierSurvives)}%</span> of
          simulated futures.
        </p>
      )}
    </ChartFrame>
  );
}

