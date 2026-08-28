'use client';

/**
 * Two or three players, side by side, on the numbers the decision turns on.
 *
 * The joint row at the bottom is the reason this exists rather than being two
 * drawers open at once: "can I get both" is a question about a pair, and it is
 * answered by counting the futures in which both survived - never by
 * multiplying two survival percentages, which assumes an independence a draft
 * room does not have.
 */
import type { JointOutcome } from '@/packages/engine/draft/joint-availability';
import type { PlayerAnalysis } from '@/packages/ui/player-analysis';
import { buildCompareVerdict } from '@/packages/ui/compare-verdict';
import { stackSegments } from '@/packages/ui/charts';
import { SURVIVAL_COLOR, formatPoints, formatSurvival, survivalTone } from '@/packages/ui/theme';
import { describeNeed } from '@/packages/ui/plain-language';
import { Drawer, EmptyNote, PositionTag } from './primitives';

const JOINT_COLORS = { both: '#b9ff38', one: '#54a9f0', neither: '#ff7a59' };

export function PlayerCompare({
  analyses,
  open,
  onClose,
  onOpenPlayer,
  onRemove,
  jointFor,
}: {
  analyses: PlayerAnalysis[];
  open: boolean;
  onClose: () => void;
  onOpenPlayer: (playerId: string) => void;
  onRemove: (playerId: string) => void;
  /** Counted from the simulated futures. Null when the simulation did not run. */
  jointFor: (a: string, b: string) => JointOutcome | null;
}) {
  if (analyses.length === 0) return null;
  const pair =
    analyses.length === 2
      ? jointFor(analyses[0].header.playerId, analyses[1].header.playerId)
      : null;
  const verdict = buildCompareVerdict(analyses);

  const rows: { label: string; value: (analysis: PlayerAnalysis) => string; tone?: boolean }[] = [
    {
      label: 'Expert rank',
      value: (a) => (a.header.firstSeedRank === null ? 'Unranked' : `#${a.header.firstSeedRank}`),
    },
    { label: 'League projection', value: (a) => formatPoints(a.header.leagueProjection) },
    {
      label: 'Others like him left',
      value: (a) =>
        a.header.playersRemainingInTier > 0 ? String(a.header.playersRemainingInTier) : 'None',
    },
    {
      label: "Chance he's still available",
      value: (a) =>
        a.survival === null ? '—' : formatSurvival(a.survival.probability, a.survival.confidence),
      tone: true,
    },
    {
      label: 'Added to your roster',
      value: (a) =>
        a.replacement?.subject.rosterGain === null || !a.replacement
          ? '—'
          : `${formatPoints(a.replacement.subject.rosterGain)} pts`,
    },
    {
      label: 'Roster need',
      value: (a) =>
        a.need === null
          ? '—'
          : describeNeed(a.need.level, a.need.openStartingSlots),
    },
  ];

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={
        <div>
          <h2 className="text-lg font-black tracking-[-0.03em] text-white">Compare</h2>
          <p className="mt-0.5 text-[11px] font-bold text-[#7f919c]">
            {analyses.map((analysis) => analysis.header.name).join(' vs ')}
          </p>
        </div>
      }
    >
      {verdict && <Verdict verdict={verdict} onOpenPlayer={onOpenPlayer} />}

      <details className="mt-4 rounded-xl border border-[#1e2f3a] bg-[#0a141c] p-3">
        <summary className="cursor-pointer text-[10px] font-black uppercase tracking-[0.13em] text-[#71838e]">
          View detailed comparison
        </summary>
        <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[26rem] border-separate border-spacing-0">
          <thead>
            <tr>
              <th className="w-32 border-b border-[#1e2f3a] px-2 py-2 text-left text-[9px] font-black uppercase tracking-[0.12em] text-[#5f7280]">
                Metric
              </th>
              {analyses.map((analysis) => (
                <th
                  key={analysis.header.playerId}
                  className="border-b border-[#1e2f3a] px-2 py-2 text-left"
                >
                  <div className="flex items-center gap-1.5">
                    <PositionTag position={analysis.header.position} size="sm" />
                    <button
                      onClick={() => onOpenPlayer(analysis.header.playerId)}
                      className="min-w-0 truncate text-[12px] font-black text-[#e2e8eb] hover:underline"
                    >
                      {analysis.header.name}
                    </button>
                  </div>
                  <button
                    onClick={() => onRemove(analysis.header.playerId)}
                    className="mt-1 text-[9px] font-bold uppercase tracking-[0.08em] text-[#4d5f6b] hover:text-[#ff9a80]"
                  >
                    Remove
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <th
                  scope="row"
                  className="border-b border-[#16242d] px-2 py-2 text-left text-[11px] font-semibold text-[#7f919c]"
                >
                  {row.label}
                </th>
                {analyses.map((analysis) => (
                  <td
                    key={analysis.header.playerId}
                    className="border-b border-[#16242d] px-2 py-2 text-[12px] font-bold tabular-nums"
                    style={
                      row.tone && analysis.survival
                        ? { color: SURVIVAL_COLOR[survivalTone(analysis.survival.probability)] }
                        : { color: '#c3d1d9' }
                    }
                  >
                    {row.value(analysis)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        </div>

      <section className="mt-4 border-t border-[#16242d] pt-3.5">
        <h3 className="text-[10px] font-black uppercase tracking-[0.13em] text-[#71838e]">
          Can you get both?
        </h3>
        {analyses.length !== 2 ? (
          <EmptyNote>Pick exactly two players to see the joint outcome.</EmptyNote>
        ) : pair === null ? (
          <EmptyNote>
            The room simulation did not cover both of these players, so there is
            no counted joint outcome to show.
          </EmptyNote>
        ) : (
          <>
            <div className="mt-3 flex h-3 overflow-hidden rounded-full">
              {stackSegments([
                { key: 'both', value: pair.bothSurvive },
                { key: 'one', value: Math.max(0, pair.atLeastOneSurvives - pair.bothSurvive) },
                { key: 'neither', value: pair.neitherSurvives },
              ]).map((segment) => (
                <span
                  key={segment.key}
                  style={{
                    width: `${segment.percent}%`,
                    background: JOINT_COLORS[segment.key as keyof typeof JOINT_COLORS],
                  }}
                />
              ))}
            </div>
            <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
              <JointStat
                label="Both still there"
                value={pair.bothSurvive}
                color={JOINT_COLORS.both}
              />
              <JointStat
                label="Just one of them"
                value={pair.atLeastOneSurvives - pair.bothSurvive}
                color={JOINT_COLORS.one}
              />
              <JointStat
                label="Both gone"
                value={pair.neitherSurvives}
                color={JOINT_COLORS.neither}
              />
            </dl>
            {/* The decision the chart is actually about, said in one line. */}
            <p className="mt-3 text-[12px] leading-5 text-[#c3d1d9]">
              Chance you can still get one of these two at your next pick:{' '}
              <span className="font-black text-[#e2e8eb]">
                {Math.round(pair.atLeastOneSurvives)}%
              </span>
            </p>
            {pair.bSurvivesGivenAGone !== null && (
              <p className="mt-3 text-[11.5px] leading-5 text-[#8fa0aa]">
                If {analyses[0].header.name} is gone, {analyses[1].header.name} is still there{' '}
                <span className="font-black text-[#e2e8eb]">
                  {Math.round(pair.bSurvivesGivenAGone)}%
                </span>{' '}
                of the time.
              </p>
            )}
          </>
        )}
      </section>
      </details>
    </Drawer>
  );
}

const EDGE_LABEL = {
  slight: { text: 'Slight edge', tone: '#8fa0aa' },
  moderate: { text: 'Moderate edge', tone: '#e0a13c' },
  strong: { text: 'Strong edge', tone: '#b9ff38' },
} as const;

/**
 * The answer, in the first five seconds.
 *
 * Which player, why, and the honest conditions under which the other one is
 * right. Everything numeric is one disclosure away, which is the correct order:
 * a drafter who disagrees with the verdict will open it, and one who does not
 * should never have to.
 */
function Verdict({
  verdict,
  onOpenPlayer,
}: {
  verdict: NonNullable<ReturnType<typeof buildCompareVerdict>>;
  onOpenPlayer: (playerId: string) => void;
}) {
  const edge = EDGE_LABEL[verdict.edge];
  return (
    <section className="rounded-xl border border-[#b9ff38]/25 bg-[#101d0d] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[10px] font-black uppercase tracking-[0.13em] text-[#b9ff38]">
          Juancho&apos;s take
        </h3>
        <span
          className="text-[10px] font-black uppercase tracking-[0.1em]"
          style={{ color: edge.tone }}
        >
          {edge.text}
        </span>
      </div>

      <button
        onClick={() => onOpenPlayer(verdict.winnerId)}
        className="mt-2 text-left text-[17px] font-black leading-6 tracking-[-0.02em] text-white hover:underline"
      >
        {verdict.summary}
      </button>

      {verdict.caveat && (
        <p className="mt-2 text-[11.5px] leading-5 text-[#e5bd70]">{verdict.caveat}</p>
      )}

      <ul className="mt-2.5 flex flex-col gap-1.5">
        {verdict.reasons.map((reason) => (
          <li key={reason} className="text-[12.5px] leading-6 text-[#c3d1d9]">
            {reason}
          </li>
        ))}
      </ul>

      <dl className="mt-3.5 grid gap-2 border-t border-[#ffffff14] pt-3 sm:grid-cols-2">
        {verdict.cases.map((option) => (
          <div key={option.playerId}>
            <dt className="text-[11px] font-black text-[#e2e8eb]">
              Take {option.name} if…
            </dt>
            <dd className="mt-0.5 text-[11.5px] leading-5 text-[#8fa0aa]">{option.when}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function JointStat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div>
      <dt className="text-[9px] font-black uppercase tracking-[0.1em] text-[#5f7280]">{label}</dt>
      <dd className="mt-0.5 text-lg font-black tabular-nums" style={{ color }}>
        {Math.round(value)}%
      </dd>
    </div>
  );
}
