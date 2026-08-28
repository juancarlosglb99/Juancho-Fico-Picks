'use client';

/**
 * The availability half of the drawer's charts: what the room does next.
 *
 * Every figure here is COUNTED over the same simulated continuations of this
 * exact draft, never modelled after the fact. That is why the joint outcomes
 * and the individual survival numbers can never contradict each other, and why
 * the simulated-roster chart shows a quartile range rather than a smooth curve
 * drawn through three points.
 */
import type {
  JointView,
  NextPickPlanView,
  OpponentPressureView,
  SurvivalView,
} from '@/packages/ui/player-analysis';
import type { CandidateSimulationResult } from '@/packages/engine/mock/types';
import { barDomain, barPercent, stackSegments } from '@/packages/ui/charts';
import { SURVIVAL_COLOR, displayEnum, formatPoints, survivalTone } from '@/packages/ui/theme';
import { Meter, PositionTag } from './primitives';
import { ChartFrame } from './charts';

/* --------------------------------------------------------------- C. survival */

export function SurvivalChart({ view }: { view: SurvivalView }) {
  const tone = survivalTone(view.probability);
  return (
    <ChartFrame
      title="Chance he's still available at your next pick"
      caption={
        view.runs
          ? `Counted over ${view.runs} simulated versions of the rest of this draft.`
          : 'Estimated from expert rank and how many teams ahead of you need the position.'
      }
    >
      <div className="flex items-end justify-between gap-4">
        <p className="text-4xl font-black tabular-nums" style={{ color: SURVIVAL_COLOR[tone] }}>
          {view.confidence === 'high' ? '' : '≈'}
          {Math.round(view.probability)}%
        </p>
        <dl className="grid grid-cols-3 gap-3 text-right">
          <Stat label="Picks before yours" value={String(view.interveningSelections)} />
          <Stat label="Teams who need one" value={String(view.teamsWithNeed)} />
          <Stat label="Confidence" value={displayEnum(view.confidence)} />
        </dl>
      </div>
      <div className="mt-3">
        <Meter percent={view.probability} color={SURVIVAL_COLOR[tone]} height={10} />
      </div>
    </ChartFrame>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[9px] font-black uppercase tracking-[0.1em] text-[#5f7280]">{label}</dt>
      <dd className="mt-0.5 text-[12px] font-bold text-[#c3d1d9]">{value}</dd>
    </div>
  );
}

/* ------------------------------------------------------- E. joint availability */

const JOINT_COLORS = { both: '#b9ff38', one: '#54a9f0', neither: '#ff7a59' };

export function JointChart({ view, subjectName }: { view: JointView; subjectName: string }) {
  return (
    <ChartFrame
      title="Can you get both?"
      caption={`Counted over the same ${view.runs} simulated futures, so these never disagree with the individual survival numbers.`}
    >
      <ul className="flex flex-col gap-3">
        {view.rows.map((row) => {
          const segments = stackSegments([
            { key: 'both', value: row.bothSurvive },
            { key: 'one', value: Math.max(0, row.atLeastOneSurvives - row.bothSurvive) },
            { key: 'neither', value: row.neitherSurvives },
          ]);
          return (
            <li key={row.playerId}>
              <div className="flex items-center gap-2">
                <PositionTag position={row.position} size="sm" />
                <span className="min-w-0 flex-1 truncate text-[11.5px] font-bold text-[#c3d1d9]">
                  {subjectName} + {row.name}
                </span>
                <span className="shrink-0 text-[10px] font-bold text-[#5f7280]">
                  {row.reason === 'engine_pick'
                    ? 'recommended pick'
                    : row.reason === 'same_tier'
                      ? 'similar quality'
                      : 'alternative'}
                </span>
              </div>
              <div className="mt-1.5 flex h-3 overflow-hidden rounded-full">
                {segments.map((segment) => (
                  <span
                    key={segment.key}
                    style={{
                      width: `${segment.percent}%`,
                      background: JOINT_COLORS[segment.key as keyof typeof JOINT_COLORS],
                    }}
                  />
                ))}
              </div>
              <p className="mt-1.5 text-[10.5px] text-[#7f919c]">
                both {Math.round(row.bothSurvive)}% · one{' '}
                {Math.round(row.atLeastOneSurvives - row.bothSurvive)}% · neither{' '}
                {Math.round(row.neitherSurvives)}%
                {row.otherSurvivesGivenSubjectGone !== null && (
                  <>
                    {' · '}
                    {row.name} survives {Math.round(row.otherSurvivesGivenSubjectGone)}% of the time{' '}
                    {subjectName} does not
                  </>
                )}
              </p>
            </li>
          );
        })}
      </ul>
    </ChartFrame>
  );
}

/* --------------------------------------------------------- F. opponent pressure */

export function PressureChart({ view }: { view: OpponentPressureView }) {
  const max = Math.max(...view.rows.map((row) => row.pressure), 1);
  return (
    <ChartFrame
      title={`Who else wants a ${view.position}`}
      caption={`${view.teamsWithNeed} of the teams picking in your ${view.totalSelectionsBefore}-selection gap still have a starting ${view.position} slot open.`}
    >
      <ul className="flex flex-col gap-2">
        {view.rows.map((row) => (
          <li key={`${row.rosterId}-${row.selections[0]}`} className="grid grid-cols-[minmax(0,8rem)_1fr_auto] items-center gap-2">
            <span className="truncate text-[11px] font-semibold text-[#c3d1d9]">{row.teamName}</span>
            <Meter
              percent={(row.pressure / max) * 100}
              color={row.openStartingSlots > 0 ? '#ff7a59' : '#25404f'}
              height={9}
            />
            <span className="text-[10px] font-bold tabular-nums text-[#5f7280]">
              {row.selections.map((pick) => `#${pick}`).join(' ')}
            </span>
          </li>
        ))}
      </ul>
    </ChartFrame>
  );
}

/* ------------------------------------------------------- G. simulated outcomes */

/**
 * The range of finished rosters, from actual simulated drafts.
 *
 * A quartile range and a mean, because that is genuinely what the Monte Carlo
 * comparison returns. Drawing a smooth density from these three numbers would
 * be inventing the shape of a distribution we did not measure.
 */
export function SimulationChart({
  candidates,
  simulations,
  nameOf,
  subjectId,
}: {
  candidates: CandidateSimulationResult[];
  simulations: number;
  nameOf: (playerId: string) => string;
  subjectId: string;
}) {
  const lows = candidates.map((candidate) => candidate.rosterScoreP25);
  const highs = candidates.map((candidate) => candidate.rosterScoreP75);
  const domain = barDomain([...lows, ...highs], { includeZero: false });

  return (
    <ChartFrame
      title="Simulated final rosters"
      caption={`${simulations} complete draft continuations per candidate. The bar is the middle half of outcomes; the mark is the mean.`}
    >
      <ul className="flex flex-col gap-3">
        {candidates.map((candidate) => {
          const left = barPercent(candidate.rosterScoreP25, domain);
          const right = barPercent(candidate.rosterScoreP75, domain);
          const mean = barPercent(candidate.averageRosterScore, domain);
          const subject = candidate.playerId === subjectId;
          return (
            <li key={candidate.playerId}>
              <div className="flex items-baseline justify-between gap-2">
                <span
                  className={`truncate text-[11.5px] ${subject ? 'font-black text-white' : 'font-semibold text-[#8fa0aa]'}`}
                >
                  {nameOf(candidate.playerId)}
                </span>
                <span className="shrink-0 text-[11px] font-bold tabular-nums text-[#c3d1d9]">
                  {formatPoints(candidate.averageRosterScore)}
                </span>
              </div>
              <div className="relative mt-1.5 h-3 rounded-full bg-[#1a2a34]">
                <span
                  className="absolute inset-y-0 rounded-full"
                  style={{
                    left: `${left}%`,
                    width: `${Math.max(1.5, right - left)}%`,
                    background: subject ? '#b9ff3855' : '#25404f',
                  }}
                />
                <span
                  className="absolute inset-y-0 w-[2px] rounded"
                  style={{ left: `${mean}%`, background: subject ? '#b9ff38' : '#8fa0aa' }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </ChartFrame>
  );
}

/* ------------------------------------------------------------ H. next-pick plan */

export function PlanTimeline({
  plan,
  onOpenPlayer,
}: {
  plan: NextPickPlanView;
  onOpenPlayer: (playerId: string) => void;
}) {
  return (
    <ChartFrame
      title="The plan from here"
      caption="Built from your own open starting slots and the players the simulation most often leaves on the board."
    >
      <ol className="relative flex flex-col gap-3 border-l border-[#25404f] pl-4">
        {plan.steps.map((step, index) => (
          <li key={`${step.kind}-${index}`} className="relative">
            <span
              className="absolute -left-[1.3rem] top-1 h-2.5 w-2.5 rounded-full border-2 border-[#0a141c]"
              style={{
                background:
                  step.kind === 'now'
                    ? '#b9ff38'
                    : step.kind === 'obligation'
                      ? '#e0a13c'
                      : '#3d5866',
              }}
            />
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-[12.5px] font-black text-[#e2e8eb]">{step.label}</span>
              {step.overallPick !== null && (
                <span className="text-[10px] font-bold tabular-nums text-[#5f7280]">
                  pick #{step.overallPick}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-[11px] leading-5 text-[#7f919c]">{step.detail}</p>
            {step.expected.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {step.expected.map((entry) => (
                  <button
                    key={entry.playerId}
                    onClick={() => onOpenPlayer(entry.playerId)}
                    className="rounded-md border border-[#25373f] px-2 py-1 text-[10px] font-bold text-[#8fa0aa] transition hover:border-[#3d525f] hover:text-white"
                  >
                    {entry.name}
                    <span className="ml-1.5 tabular-nums text-[#4d5f6b]">
                      {Math.round(entry.frequency)}%
                    </span>
                  </button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ol>
      {plan.strategistPlan && (
        <p className="mt-3 border-t border-[#16242d] pt-2.5 text-[11.5px] leading-6 text-[#c3d1d9]">
          <span className="font-black uppercase tracking-[0.1em] text-[#5f7280]">Strategist</span>{' '}
          {plan.strategistPlan}
        </p>
      )}
    </ChartFrame>
  );
}
