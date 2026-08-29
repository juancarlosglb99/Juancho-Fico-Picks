'use client';

/**
 * The left rail: our own roster, and the holes in it.
 *
 * Ordered so the empty slots are impossible to miss. A drafter who glances left
 * should learn what he still has to fill before he learns anything else, which
 * is why the empty rows are drawn with a dashed outline and the position they
 * are waiting for rather than being collapsed away.
 */
import type { MyTeamModel, RosterEntry } from '@/packages/ui/my-team';
import { formatPoints, positionPalette, slotLabel } from '@/packages/ui/theme';
import { EmptyNote, Panel, PanelTitle, PositionTag } from './primitives';

export function MyTeamRail({
  team,
  ourNextPick,
  picksUntilTurn,
  onSelectPlayer,
}: {
  team: MyTeamModel;
  ourNextPick: number | null;
  picksUntilTurn: number | null;
  onSelectPlayer: (playerId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Panel>
        <PanelTitle
          action={
            team.startingPoints !== null ? (
              <span className="text-[10px] font-bold tabular-nums text-[#7f919c]">
                {formatPoints(team.startingPoints)} pts
              </span>
            ) : undefined
          }
        >
          My starting lineup
        </PanelTitle>

        <ul className="flex flex-col gap-1">
          {team.starters.map((view) => {
            const key = `${view.slot}-${view.index}`;
            const palette = positionPalette(view.slot);
            if (!view.player) {
              return (
                <li
                  key={key}
                  className="flex items-center gap-2 rounded-lg border border-dashed px-2 py-1.5"
                  style={{ borderColor: palette.border }}
                >
                  <SlotChip slot={view.slot} />
                  <span className="text-[11px] font-bold text-[#5f7280]">Empty</span>
                </li>
              );
            }
            return (
              <li key={key}>
                <button
                  onClick={() => onSelectPlayer(view.player!.playerId)}
                  className="flex w-full items-center gap-2 rounded-lg bg-[#111f28] px-2 py-1.5 text-left transition hover:bg-[#16262f]"
                >
                  <SlotChip slot={view.slot} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-bold text-[#e2e8eb]">
                      {view.player.name}
                    </span>
                    <span className="block truncate text-[10px] text-[#60727d]">
                      {view.player.position}
                      {view.player.team ? ` · ${view.player.team}` : ''}
                      {view.player.round !== null ? ` · R${view.player.round}` : ''}
                    </span>
                  </span>
                  {view.player.projectedPoints !== null && (
                    <span className="shrink-0 text-[11px] font-bold tabular-nums text-[#7f919c]">
                      {formatPoints(view.player.projectedPoints)}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </Panel>

      <Panel>
        <PanelTitle
          action={
            <span className="text-[10px] font-bold text-[#4d5f6b]">
              {team.bench.length} of {team.bench.length + team.emptyBenchSlots}
            </span>
          }
        >
          Bench
        </PanelTitle>
        {team.bench.length === 0 ? (
          <EmptyNote>Nothing on the bench yet.</EmptyNote>
        ) : (
          <ul className="flex flex-col gap-1">
            {team.bench.map((entry) => (
              <BenchRow key={entry.playerId} entry={entry} onSelect={onSelectPlayer} />
            ))}
          </ul>
        )}
      </Panel>

      <Panel>
        <PanelTitle>Roster need</PanelTitle>
        <ul className="grid grid-cols-2 gap-1.5">
          {team.needs.map((need) => {
            const palette = positionPalette(need.position);
            const open = need.open > 0;
            return (
              <li
                key={need.position}
                className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5"
                style={{
                  background: open ? palette.bg : '#111f28',
                  border: `1px solid ${open ? palette.border : 'transparent'}`,
                }}
              >
                <span className="text-[11px] font-black" style={{ color: palette.fg }}>
                  {need.position}
                </span>
                <span className="text-[11px] font-bold tabular-nums text-[#8fa0aa]">
                  {need.filled}/{need.required}
                </span>
              </li>
            );
          })}
        </ul>
        {team.openStartingPositions.length > 0 && (
          <p className="mt-2.5 text-[11px] leading-5 text-[#8fa0aa]">
            Still to fill:{' '}
            <span className="font-bold text-[#e2e8eb]">
              {team.openStartingPositions
                .map((entry) =>
                  entry.count > 1 ? `${entry.count}× ${entry.position}` : entry.position,
                )
                .join(' · ')}
            </span>
          </p>
        )}
      </Panel>

      <Panel>
        <PanelTitle>Your next selection</PanelTitle>
        {ourNextPick === null ? (
          <EmptyNote>
            No further selection is scheduled for you in this draft.
          </EmptyNote>
        ) : (
          <div className="flex items-baseline gap-2">
            <p className="text-2xl font-black tabular-nums tracking-[-0.04em] text-[#e8f0f4]">
              #{ourNextPick}
            </p>
            <p className="text-[11px] font-bold text-[#7f919c]">
              {picksUntilTurn === 0
                ? 'You are on the clock'
                : picksUntilTurn === null
                  ? 'turn order unavailable'
                  : `${picksUntilTurn} ${picksUntilTurn === 1 ? 'pick' : 'picks'} away`}
            </p>
          </div>
        )}
      </Panel>
    </div>
  );
}

function SlotChip({ slot }: { slot: string }) {
  const palette = positionPalette(slot);
  return (
    <span
      className="w-12 shrink-0 rounded px-1 py-0.5 text-center text-[9px] font-black uppercase tracking-[0.06em]"
      style={{ color: palette.fg, background: palette.bg }}
    >
      {slotLabel(slot)}
    </span>
  );
}

function BenchRow({
  entry,
  onSelect,
}: {
  entry: RosterEntry;
  onSelect: (playerId: string) => void;
}) {
  return (
    <li>
      <button
        onClick={() => onSelect(entry.playerId)}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-[#111f28]"
      >
        <PositionTag position={entry.position} size="sm" />
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-[#c3d1d9]">
          {entry.name}
        </span>
        {entry.projectedPoints !== null && (
          <span className="shrink-0 text-[10px] font-bold tabular-nums text-[#5f7280]">
            {formatPoints(entry.projectedPoints)}
          </span>
        )}
      </button>
    </li>
  );
}
