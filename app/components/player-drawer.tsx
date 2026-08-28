'use client';

/**
 * One drawer for every player, wherever you clicked them.
 *
 * It opens over the draft room rather than navigating away, because leaving the
 * live board to read about a player is not something a drafter can afford. On a
 * phone it is a sheet that stops below the recommendation strip, so the pick is
 * still on screen while you read.
 *
 * The tabs are a deliberate ordering of how a decision actually gets made: is
 * he good, what does he cost me, will he be there, and only then what the
 * simulation says.
 */
import { useMemo, useState } from 'react';
import type { PlayerAnalysis } from '@/packages/ui/player-analysis';
import type { CandidateSimulationResult } from '@/packages/engine/mock/types';
import { displayEnum, formatPoints, formatSlots } from '@/packages/ui/theme';
import { PeerChart, ReplacementChart, TierChart } from './charts';
import {
  JointChart,
  PlanTimeline,
  PressureChart,
  SimulationChart,
  SurvivalChart,
} from './charts-availability';
import { Drawer, EmptyNote, LoadingMark, Pill, PositionTag, Segmented } from './primitives';

type Tab = 'overview' | 'value' | 'survival' | 'simulation';

export interface SimulationState {
  status: 'idle' | 'running' | 'ready' | 'unavailable';
  candidates: CandidateSimulationResult[];
  simulations: number;
  message: string | null;
}

export function PlayerDrawer({
  analysis,
  open,
  onClose,
  onOpenPlayer,
  simulation,
  onRunSimulation,
  nameOf,
}: {
  analysis: PlayerAnalysis | null;
  open: boolean;
  onClose: () => void;
  onOpenPlayer: (playerId: string) => void;
  simulation: SimulationState;
  onRunSimulation: (playerId: string) => void;
  nameOf: (playerId: string) => string;
}) {
  const [tab, setTab] = useState<Tab>('overview');

  const tabs = useMemo(() => {
    if (!analysis) return [];
    const options: { value: Tab; label: string }[] = [{ value: 'overview', label: 'Overview' }];
    if (analysis.replacement || analysis.tierCliff) options.push({ value: 'value', label: 'Draft value' });
    if (analysis.survival || analysis.joint || analysis.opponentPressure) {
      options.push({ value: 'survival', label: 'Survival' });
    }
    if (!analysis.header.drafted) options.push({ value: 'simulation', label: 'Simulation' });
    return options;
  }, [analysis]);

  if (!analysis) return null;
  const header = analysis.header;
  const active = tabs.some((option) => option.value === tab) ? tab : 'overview';

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <PositionTag position={header.position} />
            <h2 className="truncate text-lg font-black tracking-[-0.03em] text-white">
              {header.name}
            </h2>
            {header.drafted ? (
              <Pill tone="quiet">Drafted</Pill>
            ) : header.engineRank !== null && header.engineRank <= 3 ? (
              <Pill tone="accent">Engine #{header.engineRank}</Pill>
            ) : null}
            {header.status && <Pill tone="warn">{header.status}</Pill>}
          </div>
          <p className="mt-1 truncate text-[11px] font-bold text-[#7f919c]">
            {header.team || 'FA'}
            {header.firstSeedRank !== null && ` · First Seed #${header.firstSeedRank}`}
            {header.tier !== null && ` · Tier ${header.tier}`}
            {header.leagueProjection !== null && ` · ${formatPoints(header.leagueProjection)} pts`}
            {header.age !== null && ` · age ${header.age}`}
          </p>
        </div>
      }
    >
      {tabs.length > 1 && (
        <div className="mb-4">
          <Segmented options={tabs} value={active} onChange={setTab} size="sm" />
        </div>
      )}

      {active === 'overview' && (
        <div className="flex flex-col gap-3">
          {analysis.dataWarning && (
            <p className="rounded-xl border border-[#5a4630] bg-[#251d12] p-3 text-[11.5px] leading-5 text-[#e5bd70]">
              {analysis.dataWarning.detail}
            </p>
          )}
          {analysis.engineReasons.length > 0 && (
            <section className="rounded-xl border border-[#1e2f3a] bg-[#0a141c] p-3.5">
              <h3 className="text-[10px] font-black uppercase tracking-[0.13em] text-[#71838e]">
                Why the engine rates him
              </h3>
              <ul className="mt-2.5 flex flex-col gap-1.5">
                {analysis.engineReasons.map((reason) => (
                  <li key={reason} className="flex gap-2 text-[12px] leading-6 text-[#c3d1d9]">
                    <span className="shrink-0 text-[#b9ff38]">+</span>
                    {reason}
                  </li>
                ))}
              </ul>
              {analysis.need && (
                <p className="mt-3 border-t border-[#16242d] pt-2.5 text-[11px] text-[#7f919c]">
                  Your roster: {analysis.need.drafted} at this position,{' '}
                  {formatSlots(analysis.need.openStartingSlots)} starting{' '}
                  {Math.round(analysis.need.openStartingSlots) === 1 ? 'slot' : 'slots'} open ·
                  need{' '}
                  <span className="font-bold text-[#c3d1d9]">
                    {displayEnum(analysis.need.level)}
                  </span>
                </p>
              )}
            </section>
          )}
          {analysis.peers && <PeerChart peers={analysis.peers} />}
          {analysis.plan && <PlanTimeline plan={analysis.plan} onOpenPlayer={onOpenPlayer} />}
          {header.drafted && (
            <EmptyNote>
              He has already been drafted, so nothing here forecasts his
              availability.
            </EmptyNote>
          )}
        </div>
      )}

      {active === 'value' && (
        <div className="flex flex-col gap-3">
          {analysis.replacement && <ReplacementChart view={analysis.replacement} />}
          {analysis.tierCliff && <TierChart view={analysis.tierCliff} />}
        </div>
      )}

      {active === 'survival' && (
        <div className="flex flex-col gap-3">
          {analysis.survival && <SurvivalChart view={analysis.survival} />}
          {analysis.joint && <JointChart view={analysis.joint} subjectName={header.name} />}
          {analysis.opponentPressure && <PressureChart view={analysis.opponentPressure} />}
        </div>
      )}

      {active === 'simulation' && (
        <SimulationTab
          simulation={simulation}
          onRun={() => onRunSimulation(header.playerId)}
          nameOf={nameOf}
          subjectId={header.playerId}
        />
      )}
    </Drawer>
  );
}

/**
 * The one thing in the drawer that costs real work, so it is asked for.
 *
 * Sixty complete draft continuations per candidate takes a moment on a phone,
 * and nobody needs it to make most picks. "Deeper analytics only when
 * requested" is the whole reason this is a button.
 */
function SimulationTab({
  simulation,
  onRun,
  nameOf,
  subjectId,
}: {
  simulation: SimulationState;
  onRun: () => void;
  nameOf: (playerId: string) => string;
  subjectId: string;
}) {
  if (simulation.status === 'ready' && simulation.candidates.length > 0) {
    return (
      <div className="flex flex-col gap-3">
        <SimulationChart
          candidates={simulation.candidates}
          simulations={simulation.simulations}
          nameOf={nameOf}
          subjectId={subjectId}
        />
        <button
          onClick={onRun}
          className="rounded-lg border border-[#22333e] py-2 text-[11px] font-black uppercase tracking-[0.1em] text-[#7f919c] transition hover:border-[#3d525f] hover:text-white"
        >
          Run again
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[#1e2f3a] bg-[#0a141c] p-4">
      <h3 className="text-[10px] font-black uppercase tracking-[0.13em] text-[#71838e]">
        Simulated final rosters
      </h3>
      <p className="mt-2 text-[12px] leading-6 text-[#8fa0aa]">
        Plays the rest of the draft out many times for this player and for the
        strongest alternatives, and compares the finished rosters. It takes a
        few seconds, so it only runs when you ask.
      </p>
      {simulation.message && (
        <p className="mt-2 text-[11.5px] leading-5 text-[#e0a13c]">{simulation.message}</p>
      )}
      <button
        onClick={onRun}
        disabled={simulation.status === 'running' || simulation.status === 'unavailable'}
        className="mt-3 flex items-center justify-center gap-2 rounded-lg bg-[#b9ff38] px-4 py-2 text-[11px] font-black uppercase tracking-[0.1em] text-[#071019] transition hover:bg-[#cbff6e] disabled:opacity-50"
      >
        {simulation.status === 'running' && <LoadingMark className="h-3.5 w-3.5" />}
        {simulation.status === 'running' ? 'Simulating' : 'Run simulation'}
      </button>
    </div>
  );
}
