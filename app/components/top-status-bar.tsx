'use client';

/**
 * The bar that is always there.
 *
 * Everything on it is a fact from `deriveDraftStatus`: the round, the pick, our
 * next turn, how fresh the board is, and how long the current selection has
 * been on the clock. There is no countdown, because Sleeper does not publish a
 * deadline and a plausible-looking wrong one is worse than none.
 */
import type { DraftStatusModel } from '@/packages/ui/status';
import { formatAge, formatClock } from '@/packages/ui/status';
import { Brand, Dot } from './primitives';

const TONE_COLOR: Record<DraftStatusModel['connection']['tone'], string> = {
  live: '#b9ff38',
  reconnecting: '#fbbf24',
  idle: '#b8c3c9',
  ended: '#7f919c',
};

export function TopStatusBar({
  status,
  onLeave,
  right,
}: {
  status: DraftStatusModel;
  onLeave: () => void;
  right?: React.ReactNode;
}) {
  const yourPick = status.phase === 'your_pick';
  const toneColor = TONE_COLOR[status.connection.tone];

  return (
    <header
      className={`sticky top-0 z-40 border-b backdrop-blur transition-colors ${
        yourPick
          ? 'border-[#b9ff38]/40 bg-[#0d1a09]/95'
          : 'border-[#1c2b35] bg-[#071019]/95'
      }`}
    >
      <div className="mx-auto flex w-full max-w-[1800px] items-center gap-3 px-3 py-2 sm:gap-4 sm:px-5">
        <button
          onClick={onLeave}
          title="Leave this draft room"
          className="shrink-0 rounded-lg transition hover:opacity-80"
        >
          <Brand compact />
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <p
              className={`truncate text-[13px] font-black tracking-[-0.02em] sm:text-sm ${
                yourPick ? 'text-[#b9ff38]' : 'text-[#e8f0f4]'
              }`}
            >
              {status.headline}
            </p>
            <p className="hidden truncate text-[11px] font-semibold text-[#7f919c] sm:block">
              {status.leagueName}
              {status.isMock ? ' · Mock' : ''}
            </p>
          </div>
          <p className="truncate text-[10px] font-bold uppercase tracking-[0.1em] text-[#60727d]">
            Round {status.round}/{status.totalRounds} · Pick {status.overallPick}
            {status.picksUntilOurTurn !== null && status.picksUntilOurTurn > 0 && (
              <>
                {' · '}
                <span className="text-[#8fa0aa]">
                  {status.picksUntilOurTurn} until you
                </span>
              </>
            )}
            {status.ourNextPick !== null && status.picksUntilOurTurn !== 0 && (
              <span className="text-[#4d5f6b]"> (#{status.ourNextPick})</span>
            )}
          </p>
        </div>

        {/*
          Elapsed since the last selection, and the room's allowance beside it.
          Deliberately not a countdown - see `deriveDraftStatus`.
        */}
        {status.onClockElapsedMs !== null && (
          <div className="hidden shrink-0 text-right sm:block">
            <p className="font-mono text-sm font-bold tabular-nums text-[#c3d1d9]">
              {formatClock(status.onClockElapsedMs)}
              {status.pickTimerSeconds !== null && (
                <span className="text-[#4d5f6b]">
                  {' / '}
                  {formatClock(status.pickTimerSeconds * 1000)}
                </span>
              )}
            </p>
            <p className="text-[9px] font-bold uppercase tracking-[0.12em] text-[#4d5f6b]">
              on this pick
            </p>
          </div>
        )}

        <div className="flex shrink-0 items-center gap-2">
          {right}
          <span
            title={status.connection.detail}
            className="flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-[10px] font-black uppercase tracking-[0.1em]"
            style={{ color: toneColor, borderColor: `${toneColor}40` }}
          >
            <Dot color={toneColor} pulse={status.connection.tone === 'live'} />
            {status.connection.label}
            <span className="hidden font-semibold normal-case tracking-normal opacity-60 md:inline">
              {formatAge(status.connection.ageMs)}
            </span>
          </span>
        </div>
      </div>
    </header>
  );
}
