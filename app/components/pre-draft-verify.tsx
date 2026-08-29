'use client';

/**
 * The step between choosing a draft and entering the room.
 *
 * Everything the recommendation depends on is checked here, once, while there
 * is still time to do something about it. Each check reports what it FOUND
 * rather than a bare tick, because "4 of 12 teams" tells somebody what to do
 * and "Warning" does not - and only a genuinely missing source blocks the
 * draft, so a board that does not exactly match the format says so and gets out
 * of the way.
 */
import type { DraftReadiness, ReadinessCheck } from '@/packages/ui/readiness';
import { LoadingMark, Panel, PanelTitle, Pill } from './primitives';

export function VerifyStep({
  readiness,
  readinessBusy,
  onEnter,
  onDetach,
}: {
  readiness: DraftReadiness | null;
  readinessBusy: boolean;
  onEnter: () => void;
  onDetach: () => void;
}) {
  if (!readiness) {
    return (
      <Panel>
        <div className="flex items-center gap-3 py-4 text-[13px] font-bold text-[#8fa0aa]">
          <LoadingMark /> Loading the draft, rosters and player map…
        </div>
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-xl font-black tracking-[-0.03em]">
                {readiness.league.name}
              </h2>
              <Pill tone={readiness.league.isMock ? 'neutral' : 'accent'}>
                {readiness.league.isMock ? 'Sleeper mock' : 'Sleeper league'}
              </Pill>
            </div>
            <p className="mt-1.5 text-[12px] font-bold text-[#7f919c]">
              {readiness.league.teams} teams · {readiness.league.rounds} rounds ·{' '}
              {readiness.league.draftType} · {readiness.league.draftStatus}
            </p>
          </div>
          <button
            onClick={onDetach}
            className="rounded-lg border border-[#2a3c49] px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.08em] text-[#a8b4bc] transition hover:border-[#52646f] hover:text-white"
          >
            Choose another
          </button>
        </div>

        <dl className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Scoring" value={readiness.league.scoring} />
          <Fact label="Roster" value={readiness.league.rosterSummary} />
          <Fact label="Lineup" value={readiness.league.lineup} />
          <Fact
            label="Your team"
            value={
              readiness.us.teamName
                ? `${readiness.us.teamName}${readiness.us.draftSlot !== null ? ` · slot ${readiness.us.draftSlot}` : ''}`
                : 'Not identified'
            }
          />
        </dl>
      </Panel>

      <Panel>
        <PanelTitle
          action={readinessBusy ? <LoadingMark className="h-3 w-3 text-[#5f7280]" /> : undefined}
        >
          Data and setup
        </PanelTitle>
        <ul className="flex flex-col gap-1.5">
          {readiness.checks.map((check) => (
            <CheckRow key={check.id} check={check} />
          ))}
        </ul>
      </Panel>

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={onEnter}
          disabled={!readiness.ready}
          className="rounded-xl bg-[#b9ff38] px-6 py-3 text-[12px] font-black uppercase tracking-[0.08em] text-[#071019] transition hover:bg-[#cbff6e] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {readiness.ready ? 'Ready for draft · enter room' : 'Not ready yet'}
        </button>
        {!readiness.ready && (
          <p className="text-[12px] font-semibold text-[#e5bd70]">
            {readiness.blockers.map((check) => check.label).join(', ')} must resolve first.
          </p>
        )}
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-[#0a141c] px-3 py-2.5">
      <dt className="text-[9px] font-black uppercase tracking-[0.12em] text-[#5f7280]">{label}</dt>
      <dd className="mt-1 text-[12.5px] font-bold text-[#dfe6e9]">{value}</dd>
    </div>
  );
}

const STATUS_STYLE = {
  ok: { mark: '✓', color: '#b9ff38' },
  warn: { mark: '!', color: '#e0a13c' },
  missing: { mark: '×', color: '#ff7a59' },
  unknown: { mark: '…', color: '#7f919c' },
} as const;

function CheckRow({ check }: { check: ReadinessCheck }) {
  const style = STATUS_STYLE[check.status];
  return (
    <li className="flex items-start gap-2.5 rounded-lg px-1.5 py-1.5">
      <span
        className="mt-[1px] grid h-4 w-4 shrink-0 place-items-center rounded-full text-[10px] font-black"
        style={{ color: style.color, border: `1px solid ${style.color}55` }}
      >
        {style.mark}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-2">
          <span className="text-[12.5px] font-bold text-[#dfe6e9]">{check.label}</span>
          <span className="text-[11.5px] font-bold" style={{ color: style.color }}>
            {check.value}
          </span>
        </span>
        <span className="mt-0.5 block text-[11px] leading-5 text-[#5f7280]">{check.detail}</span>
      </span>
    </li>
  );
}
