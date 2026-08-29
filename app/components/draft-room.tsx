'use client';

/**
 * The cockpit.
 *
 * Three regions on a desktop, in the order a pick is actually made: what I
 * have, what to do, what happens next. The middle column is the widest and
 * carries the recommendation at the top, because that is the only thing on the
 * screen somebody must not have to look for.
 *
 * On a phone the three regions become three tabs - and the recommendation
 * follows you between them as a strip, so opening the board or a player's
 * analysis never costs you sight of the pick.
 */
import { useState, type ReactNode } from 'react';
import type { NormalizedDraftType } from '@/packages/engine/draft/next-pick-probability';
import type { DraftBoardModel } from '@/packages/ui/draft-board';
import type { MyTeamModel } from '@/packages/ui/my-team';
import type { NextUpModel } from '@/packages/ui/next-up';
import type { PoolRow } from '@/packages/ui/player-pool';
import type { RecommendationCard } from '@/packages/ui/recommendation';
import type { DraftStatusModel } from '@/packages/ui/status';
import { DraftBoardGrid } from './draft-board-grid';
import { MyTeamRail } from './my-team-rail';
import { NextUpRail } from './next-up-rail';
import { PlayerPoolTable } from './player-pool-table';
import { RecommendationCardView, RecommendationMiniBar } from './recommendation-card';
import { EmptyNote, Panel, Segmented } from './primitives';
import { TopStatusBar } from './top-status-bar';

type CenterView = 'players' | 'board';
type MobileTab = 'roster' | 'draft' | 'analysis';

export function DraftRoom({
  status,
  card,
  team,
  nextUp,
  pool,
  board,
  draftType,
  compareIds,
  onOpenPlayer,
  onToggleCompare,
  onCompare,
  onLeave,
  showSpend,
  headerActions,
  banner,
  footer,
}: {
  status: DraftStatusModel;
  card: RecommendationCard;
  team: MyTeamModel;
  nextUp: NextUpModel | null;
  pool: PoolRow[];
  board: DraftBoardModel;
  draftType: NormalizedDraftType;
  compareIds: string[];
  onOpenPlayer: (playerId: string) => void;
  onToggleCompare: (playerId: string) => void;
  onCompare: (playerIds: string[]) => void;
  onLeave: () => void;
  showSpend: boolean;
  headerActions?: ReactNode;
  /** Anything that must be said above the cockpit, e.g. a missing data source. */
  banner?: ReactNode;
  /** Development diagnostics, kept out of the product surface. */
  footer?: ReactNode;
}) {
  const [center, setCenter] = useState<CenterView>('players');
  const [mobileTab, setMobileTab] = useState<MobileTab>('draft');

  const centerToggle = (
    <Segmented
      options={[
        { value: 'players', label: 'Players', count: pool.length },
        { value: 'board', label: 'Draft board' },
      ]}
      value={center}
      onChange={setCenter}
    />
  );

  const centerContent = (
    <div className="flex flex-col gap-3">
      <RecommendationCardView
        card={card}
        onOpenPlayer={onOpenPlayer}
        onCompare={onCompare}
        showSpend={showSpend}
      />
      <Panel padded={false} className="p-3">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {centerToggle}
          {center === 'board' && (
            <p className="text-[10px] font-bold text-[#4d5f6b]">
              Your column is outlined · click any pick for details
            </p>
          )}
        </div>
        {center === 'players' ? (
          pool.length === 0 ? (
            <EmptyNote>
              No projected player is available. Check the data sources below.
            </EmptyNote>
          ) : (
            <PlayerPoolTable
              rows={pool}
              compareIds={compareIds}
              onOpenPlayer={onOpenPlayer}
              onToggleCompare={onToggleCompare}
            />
          )
        ) : (
          <DraftBoardGrid board={board} draftType={draftType} onOpenPlayer={onOpenPlayer} />
        )}
      </Panel>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#071019] pb-16 text-[#f7f8f2] lg:pb-0">
      <TopStatusBar status={status} onLeave={onLeave} right={headerActions} />

      {/* The phone's promise: the pick stays visible whatever else is open. */}
      {mobileTab !== 'draft' && (
        <div className="sticky top-[3.25rem] z-30 lg:hidden">
          <RecommendationMiniBar card={card} onOpen={() => setMobileTab('draft')} />
        </div>
      )}

      <div className="mx-auto w-full max-w-[1800px] px-3 py-3 sm:px-5">
        {banner && <div className="mb-3">{banner}</div>}

        {/* Desktop: three regions at once. */}
        <div className="hidden gap-3 lg:grid lg:grid-cols-[236px_minmax(0,1fr)] xl:grid-cols-[248px_minmax(0,1fr)_312px]">
          <aside className="min-w-0">
            <MyTeamRail
              team={team}
              ourNextPick={status.ourNextPick}
              picksUntilTurn={status.picksUntilOurTurn}
              onSelectPlayer={onOpenPlayer}
            />
          </aside>
          <div className="min-w-0">{centerContent}</div>
          <aside className="min-w-0 lg:col-span-2 xl:col-span-1">
            {nextUp ? (
              <NextUpRail model={nextUp} onOpenPlayer={onOpenPlayer} />
            ) : (
              <Panel>
                <EmptyNote>
                  Availability analysis needs the recommendation engine to have
                  run on this board.
                </EmptyNote>
              </Panel>
            )}
          </aside>
        </div>

        {/* Phone: one region at a time, chosen from the bottom bar. */}
        <div className="lg:hidden">
          {mobileTab === 'draft' && centerContent}
          {mobileTab === 'roster' && (
            <MyTeamRail
              team={team}
              ourNextPick={status.ourNextPick}
              picksUntilTurn={status.picksUntilOurTurn}
              onSelectPlayer={onOpenPlayer}
            />
          )}
          {mobileTab === 'analysis' &&
            (nextUp ? (
              <NextUpRail model={nextUp} onOpenPlayer={onOpenPlayer} />
            ) : (
              <Panel>
                <EmptyNote>Availability analysis is unavailable for this board.</EmptyNote>
              </Panel>
            ))}
        </div>

        {footer && <div className="mt-4">{footer}</div>}
      </div>

      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-3 border-t border-[#1c2b35] bg-[#050d13]/97 backdrop-blur lg:hidden">
        {(
          [
            ['roster', 'Roster'],
            ['draft', 'Draft'],
            ['analysis', 'Analysis'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            onClick={() => setMobileTab(value)}
            aria-pressed={mobileTab === value}
            className={`py-3 text-[11px] font-black uppercase tracking-[0.1em] transition ${
              mobileTab === value
                ? 'border-t-2 border-[#b9ff38] text-[#b9ff38]'
                : 'border-t-2 border-transparent text-[#5f7280]'
            }`}
          >
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}
