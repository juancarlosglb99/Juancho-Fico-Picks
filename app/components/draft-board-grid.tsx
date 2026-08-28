'use client';

/**
 * The board every drafter already knows how to read: teams across, rounds down.
 *
 * Two things are worth noticing in the markup. The snake is shown by the pick
 * NUMBER in each cell and an arrow on the round label, not by reordering the
 * columns - a column that moves between rounds is unreadable, and a drafter
 * tracking one opponent would lose them every other row. And a cell always
 * carries the position as letters as well as colour.
 */
import { useEffect, useRef, useState } from 'react';
import type { BoardCell, DraftBoardModel } from '@/packages/ui/draft-board';
import { roundDirection } from '@/packages/ui/draft-board';
import type { NormalizedDraftType } from '@/packages/engine/draft/next-pick-probability';
import { positionPalette } from '@/packages/ui/theme';

/** How long a newly arrived selection stays highlighted. */
const FLASH_MS = 6000;

export function DraftBoardGrid({
  board,
  draftType,
  onOpenPlayer,
}: {
  board: DraftBoardModel;
  draftType: NormalizedDraftType;
  onOpenPlayer: (playerId: string) => void;
}) {
  const flashing = useFlash(board.rounds.flatMap((round) => round.cells).find((cell) => cell.isMostRecent)?.overallPick ?? null);
  const currentRound = Math.max(
    1,
    Math.ceil(board.currentOverallPick / Math.max(1, board.teams)),
  );

  return (
    <div className="overflow-hidden rounded-xl border border-[#1e2f3a]">
      <div className="max-h-[70vh] overflow-auto overscroll-contain">
        <table className="w-full border-separate border-spacing-0">
          <thead className="sticky top-0 z-20">
            <tr>
              <th className="sticky left-0 z-30 w-9 border-b border-r border-[#1e2f3a] bg-[#0a141c] px-1 py-2 text-[9px] font-black uppercase tracking-[0.1em] text-[#5f7280]">
                Rd
              </th>
              {board.columns.map((column) => (
                <th
                  key={column.draftSlot}
                  scope="col"
                  className={`min-w-[104px] border-b border-[#1e2f3a] px-2 py-2 text-left text-[10px] font-black ${
                    column.isUs ? 'bg-[#101d0d] text-[#b9ff38]' : 'bg-[#0a141c] text-[#8fa0aa]'
                  }`}
                >
                  <span className="block truncate">{column.teamName}</span>
                  <span className="block text-[9px] font-bold text-[#4d5f6b]">
                    Slot {column.draftSlot}
                    {column.isUs ? ' · you' : ''}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {board.rounds.map((round) => (
              <tr key={round.round}>
                <th
                  scope="row"
                  className={`sticky left-0 z-10 border-b border-r border-[#1e2f3a] px-1 py-1 text-center align-middle text-[10px] font-black ${
                    round.round === currentRound
                      ? 'bg-[#132029] text-[#e2e8eb]'
                      : 'bg-[#0a141c] text-[#5f7280]'
                  }`}
                  title={`Round ${round.round} runs ${
                    roundDirection(round.round, draftType) === 'reverse'
                      ? 'right to left'
                      : 'left to right'
                  }`}
                >
                  <span className="block">{round.round}</span>
                  <span className="block text-[9px] text-[#3f4f5a]">
                    {roundDirection(round.round, draftType) === 'reverse' ? '←' : '→'}
                  </span>
                </th>
                {round.cells.map((cell) => (
                  <td key={cell.overallPick} className="border-b border-[#16242d] p-0.5">
                    <Cell
                      cell={cell}
                      flashing={flashing === cell.overallPick}
                      onOpenPlayer={onOpenPlayer}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Cell({
  cell,
  flashing,
  onOpenPlayer,
}: {
  cell: BoardCell;
  flashing: boolean;
  onOpenPlayer: (playerId: string) => void;
}) {
  if (!cell.player) {
    return (
      <div
        className={`flex h-11 items-center justify-center rounded-md text-[10px] font-bold tabular-nums ${
          cell.isCurrent
            ? 'bg-[#132029] text-[#b9ff38] outline outline-2 -outline-offset-2 outline-[#b9ff38]'
            : cell.isOurs
              ? 'bg-[#0e1a12] text-[#3f6b3a]'
              : 'text-[#2c3a44]'
        }`}
      >
        {cell.isCurrent ? 'ON THE CLOCK' : cell.overallPick}
      </div>
    );
  }

  const palette = positionPalette(cell.player.position);
  const clickable = cell.player.playerId !== null;

  return (
    <button
      disabled={!clickable}
      onClick={() => clickable && onOpenPlayer(cell.player!.playerId!)}
      title={`Pick ${cell.overallPick} · ${cell.player.name}`}
      className={`flex h-11 w-full flex-col justify-center rounded-md px-1.5 text-left transition ${
        flashing ? 'ring-2 ring-[#b9ff38]' : ''
      } ${clickable ? 'hover:brightness-125' : 'cursor-default'} ${
        cell.isOurs ? 'outline outline-1 -outline-offset-1 outline-[#b9ff38]/45' : ''
      }`}
      style={{ background: palette.bg }}
    >
      <span className="flex items-center gap-1">
        <span className="text-[8.5px] font-black uppercase" style={{ color: palette.fg }}>
          {cell.player.position ?? '—'}
        </span>
        <span className="text-[8.5px] font-bold tabular-nums text-[#5f7280]">
          {cell.overallPick}
        </span>
        {cell.isKeeper && <span className="text-[8px] font-bold text-[#7f919c]">K</span>}
      </span>
      <span className="truncate text-[11px] font-bold leading-tight text-[#dfe6e9]">
        {cell.player.lastName || cell.player.name}
      </span>
      <span className="truncate text-[9px] leading-tight text-[#5f7280]">
        {cell.player.firstName}
        {cell.player.team ? ` · ${cell.player.team}` : ''}
      </span>
    </button>
  );
}

/**
 * Highlights a selection briefly, then stops.
 *
 * A permanent marker on "the newest pick" is just a marker on a pick; the point
 * is to catch the eye of somebody who was looking elsewhere when it landed.
 */
function useFlash(overallPick: number | null): number | null {
  const [flashing, setFlashing] = useState<number | null>(null);
  const previous = useRef<number | null>(null);

  useEffect(() => {
    if (overallPick === null || overallPick === previous.current) return;
    previous.current = overallPick;
    setFlashing(overallPick);
    const timer = window.setTimeout(() => setFlashing(null), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [overallPick]);

  return flashing;
}
