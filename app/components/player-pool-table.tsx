'use client';

/**
 * The available board, as a table you can actually scan.
 *
 * Seven columns, not fifteen. Everything else the engine knows about a player
 * is one click away in the drawer, and putting it here instead would make the
 * one screen a drafter uses under time pressure the densest in the product.
 *
 * Drafted players are simply gone. They are on the draft board, where they
 * belong; leaving them here greyed out doubles the length of the list a drafter
 * has to read past.
 */
import { useMemo, useState } from 'react';
import {
  countByFilter,
  filterPool,
  type PoolFilter,
  type PoolRow,
  type PoolSort,
} from '@/packages/ui/player-pool';
import { SURVIVAL_COLOR, formatPoints, formatSurvival, survivalTone } from '@/packages/ui/theme';
import { EmptyNote, PositionTag, Segmented } from './primitives';

const FILTERS: PoolFilter[] = ['ALL', 'QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'DEF'];

const SORTS: { value: PoolSort; label: string }[] = [
  { value: 'engine', label: 'Best for you' },
  { value: 'first_seed', label: 'Expert rank' },
  { value: 'projection', label: 'Points' },
  { value: 'survival', label: 'Most at risk' },
  { value: 'name', label: 'Name' },
];

/** How many rows render before the list asks to be expanded. */
const PAGE = 60;

export function PlayerPoolTable({
  rows,
  compareIds,
  onOpenPlayer,
  onToggleCompare,
}: {
  rows: PoolRow[];
  compareIds: string[];
  onOpenPlayer: (playerId: string) => void;
  onToggleCompare: (playerId: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<PoolFilter>('ALL');
  const [sort, setSort] = useState<PoolSort>('engine');
  const [limit, setLimit] = useState(PAGE);

  const counts = useMemo(() => countByFilter(rows), [rows]);
  const visible = useMemo(
    () => filterPool(rows, { search, filter, sort }),
    [rows, search, filter, sort],
  );

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 pb-3">
        <input
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setLimit(PAGE);
          }}
          placeholder="Search players"
          aria-label="Search available players"
          spellCheck={false}
          className="h-9 min-w-0 flex-1 rounded-lg border border-[#22333e] bg-[#0a141c] px-3 text-[13px] font-semibold text-white outline-none placeholder:text-[#4d5c66] focus:border-[#b9ff38] sm:max-w-56"
        />
        <div className="flex flex-wrap gap-1">
          {FILTERS.filter((option) => option === 'ALL' || counts[option] > 0).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => {
                setFilter(option);
                setLimit(PAGE);
              }}
              aria-pressed={filter === option}
              className={`rounded-lg px-2.5 py-1.5 text-[10px] font-black uppercase tracking-[0.08em] transition ${
                filter === option
                  ? 'bg-[#b9ff38] text-[#071019]'
                  : 'bg-[#0a141c] text-[#7f919c] hover:text-[#dfe6e9]'
              }`}
            >
              {option}
              <span className="ml-1 opacity-55">{counts[option]}</span>
            </button>
          ))}
        </div>
        {/* Scrolls rather than wrapping: five sort options stacked two deep on
            a phone push the table itself below the fold. */}
        <div className="-mx-1 max-w-full overflow-x-auto px-1 sm:ml-auto">
          <Segmented options={SORTS} value={sort} onChange={setSort} size="sm" />
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-[#1e2f3a]">
        <div className="grid grid-cols-[minmax(0,1fr)_46px_50px_54px_56px] items-center gap-2 border-b border-[#1e2f3a] bg-[#0a141c] px-3 py-2 text-[9px] font-black uppercase tracking-[0.12em] text-[#5f7280] sm:grid-cols-[minmax(0,1fr)_52px_56px_60px_64px_72px_86px]">
          <span>Player</span>
          <span className="text-right" title="Expert consensus rank">
            Rank
          </span>
          <span className="text-right" title="Projected points for your league's scoring">
            Points
          </span>
          <span
            className="hidden text-right sm:block"
            title="How many similarly rated players remain at this position"
          >
            Similar left
          </span>
          <span className="text-right" title="Chance he is still available at your next pick">
            Available
          </span>
          <span className="hidden text-right sm:block">Your need</span>
          <span className="hidden text-right sm:block">Compare</span>
        </div>

        <div className="max-h-[58vh] overflow-y-auto overscroll-contain lg:max-h-[calc(100vh-27rem)]">
          {visible.length === 0 ? (
            <div className="px-3">
              <EmptyNote>No available player matches that search.</EmptyNote>
            </div>
          ) : (
            visible.slice(0, limit).map((row) => (
              <PoolRowView
                key={row.playerId}
                row={row}
                comparing={compareIds.includes(row.playerId)}
                onOpen={onOpenPlayer}
                onToggleCompare={onToggleCompare}
              />
            ))
          )}
        </div>
      </div>

      {visible.length > limit && (
        <button
          onClick={() => setLimit((current) => current + PAGE * 2)}
          className="mt-2 rounded-lg border border-[#22333e] py-2 text-[11px] font-black uppercase tracking-[0.1em] text-[#7f919c] transition hover:border-[#3d525f] hover:text-white"
        >
          Show more · {visible.length - limit} remaining
        </button>
      )}
    </div>
  );
}

function PoolRowView({
  row,
  comparing,
  onOpen,
  onToggleCompare,
}: {
  row: PoolRow;
  comparing: boolean;
  onOpen: (playerId: string) => void;
  onToggleCompare: (playerId: string) => void;
}) {
  const tone = survivalTone(row.survival);
  const needsIt = row.fit.openStartingSlots > 0;

  return (
    <div
      className={`grid grid-cols-[minmax(0,1fr)_46px_50px_54px_56px] items-center gap-2 border-b border-[#16242d] px-3 py-2 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_52px_56px_60px_64px_72px_86px] ${
        comparing ? 'bg-[#132029]' : 'hover:bg-[#0f1c24]'
      }`}
    >
      <button onClick={() => onOpen(row.playerId)} className="flex min-w-0 items-center gap-2 text-left">
        {row.engineRank === 1 && (
          <span
            className="shrink-0 rounded bg-[#b9ff38]/15 px-1 text-[9px] font-black uppercase tracking-[0.06em] text-[#b9ff38]"
            title="This is the recommended pick"
          >
            Pick
          </span>
        )}
        {row.engineRank !== null && row.engineRank > 1 && row.engineRank <= 3 && (
          <span
            className="shrink-0 rounded bg-[#8fa0aa]/12 px-1 text-[9px] font-black uppercase tracking-[0.06em] text-[#9fb0ba]"
            title="One of the alternatives on the recommendation card"
          >
            Alt
          </span>
        )}
        <PositionTag position={row.position} size="sm" />
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-bold text-[#e2e8eb]">
            {row.name}
            {row.hasDataWarning && (
              <span
                className="ml-1 text-[#e0a13c]"
                title="First Seed's rank and projection disagree about this player."
              >
                !
              </span>
            )}
          </span>
          <span className="block truncate text-[10px] text-[#5f7280]">{row.team || 'FA'}</span>
        </span>
      </button>

      <span
        className="truncate text-right text-[12px] font-bold tabular-nums text-[#8fa0aa]"
        title={row.expertRank ? `${row.expertRank.source}` : undefined}
      >
        {row.expertRank?.label ?? '—'}
      </span>
      <span className="text-right text-[12px] font-bold tabular-nums text-[#c3d1d9]">
        {formatPoints(row.projectedPoints)}
      </span>
      <span
        className="hidden text-right text-[12px] font-bold tabular-nums text-[#8fa0aa] sm:block"
        title={
          row.playersRemainingInTier === 1
            ? `The last ${row.position} of this quality on the board`
            : `${row.playersRemainingInTier} similarly rated ${row.position}s remain`
        }
      >
        {row.playersRemainingInTier || '—'}
      </span>
      <span
        className="text-right text-[12px] font-black tabular-nums"
        style={{ color: SURVIVAL_COLOR[tone] }}
        title={
          row.survival === null
            ? 'Not enough simulation data for this player'
            : `Chance he is still available at your next pick · ${row.survivalConfidence} confidence`
        }
      >
        {formatSurvival(row.survival, row.survivalConfidence)}
      </span>
      <span className="hidden text-right sm:block">
        {needsIt ? (
          <span
            className="rounded bg-[#b9ff38]/12 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-[0.08em] text-[#b9ff38]"
            title="You still have a starting spot open here"
          >
            Starter
          </span>
        ) : (
          <span className="text-[10px] font-bold text-[#42535e]">
            {row.fit.drafted > 0 ? `${row.fit.drafted} held` : 'Depth'}
          </span>
        )}
      </span>
      <span className="hidden text-right sm:block">
        <button
          onClick={() => onToggleCompare(row.playerId)}
          aria-pressed={comparing}
          className={`rounded-md border px-2 py-1 text-[9px] font-black uppercase tracking-[0.08em] transition ${
            comparing
              ? 'border-[#b9ff38] text-[#b9ff38]'
              : 'border-[#25373f] text-[#6d8290] hover:border-[#3d525f] hover:text-[#c3d1d9]'
          }`}
        >
          {comparing ? 'Added' : 'Compare'}
        </button>
      </span>
    </div>
  );
}
