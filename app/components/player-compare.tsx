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
import { stackSegments } from '@/packages/ui/charts';
import {
  SURVIVAL_COLOR,
  displayEnum,
  formatPoints,
  formatSlots,
  formatSurvival,
  survivalTone,
} from '@/packages/ui/theme';
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
  const pair = analyses.length === 2 ? jointFor(analyses[0].header.playerId, analyses[1].header.playerId) : null;

  const rows: { label: string; value: (analysis: PlayerAnalysis) => string; tone?: boolean }[] = [
    { label: 'First Seed rank', value: (a) => (a.header.firstSeedRank === null ? '—' : `#${a.header.firstSeedRank}`) },
    { label: 'League projection', value: (a) => formatPoints(a.header.leagueProjection) },
    {
      label: 'Tier',
      value: (a) =>
        a.header.tier === null
          ? '—'
          : `${a.header.tier} · ${a.header.playersRemainingInTier} left`,
    },
    { label: 'Engine rank', value: (a) => (a.header.engineRank === null ? 'Not shortlisted' : `#${a.header.engineRank}`) },
    {
      label: 'Survives to your turn',
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
      label: 'Positional need',
      value: (a) =>
        a.need === null
          ? '—'
          : `${displayEnum(a.need.level)} · ${formatSlots(a.need.openStartingSlots)} open`,
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
      <div className="overflow-x-auto">
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

      <section className="mt-4 rounded-xl border border-[#1e2f3a] bg-[#0a141c] p-3.5">
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
              <JointStat label="Both survive" value={pair.bothSurvive} color={JOINT_COLORS.both} />
              <JointStat
                label="Exactly one"
                value={pair.atLeastOneSurvives - pair.bothSurvive}
                color={JOINT_COLORS.one}
              />
              <JointStat label="Neither" value={pair.neitherSurvives} color={JOINT_COLORS.neither} />
            </dl>
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
    </Drawer>
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
