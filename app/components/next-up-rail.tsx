'use client';

/**
 * The right rail: what the board will look like when our turn comes round.
 *
 * Its whole job is to answer "can this wait?". Players unlikely to survive
 * first, then the tiers about to break, then the specific teams competing for
 * something we still need - and nothing else, because a rail that lists every
 * team ahead of us is a list rather than a warning.
 */
import type { NextUpModel } from '@/packages/ui/next-up';
import { describeTierDepth } from '@/packages/ui/plain-language';
import {
  SURVIVAL_COLOR,
  formatSlots,
  formatSurvival,
  survivalTone,
} from '@/packages/ui/theme';
import { EmptyNote, Meter, Panel, PanelTitle, PositionTag } from './primitives';

export function NextUpRail({
  model,
  onOpenPlayer,
}: {
  model: NextUpModel;
  onOpenPlayer: (playerId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Panel>
        <PanelTitle
          action={
            model.ourNextPick !== null ? (
              <span className="text-[10px] font-bold tabular-nums text-[#7f919c]">
                #{model.ourNextPick}
              </span>
            ) : undefined
          }
        >
          Likely gone before your next pick
        </PanelTitle>

        {model.backToBack ? (
          <EmptyNote>
            You select again immediately, so everyone on the board is still
            available. Nothing here can be lost in between.
          </EmptyNote>
        ) : model.atRisk.length === 0 ? (
          <EmptyNote>
            Nobody you are considering is likely to be gone before your next
            pick.
          </EmptyNote>
        ) : (
          <ul className="flex flex-col gap-2">
            {model.atRisk.map((row) => (
              <li key={row.playerId}>
                <button
                  onClick={() => onOpenPlayer(row.playerId)}
                  className="w-full rounded-lg px-1.5 py-1 text-left transition hover:bg-[#111f28]"
                >
                  <div className="flex items-center gap-2">
                    <PositionTag position={row.position} size="sm" />
                    <span className="min-w-0 flex-1 truncate text-[12px] font-bold text-[#e2e8eb]">
                      {row.name}
                    </span>
                    <span
                      className="shrink-0 text-[11px] font-black tabular-nums"
                      style={{ color: SURVIVAL_COLOR[survivalTone(row.survival)] }}
                    >
                      {formatSurvival(row.survival, row.confidence)}
                    </span>
                  </div>
                  <div className="mt-1">
                    <Meter
                      percent={row.survival}
                      color={SURVIVAL_COLOR[survivalTone(row.survival)]}
                      height={4}
                    />
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}

        {model.likelyToReturn.length > 0 && !model.backToBack && (
          <p className="mt-3 border-t border-[#16242d] pt-2.5 text-[11px] leading-5 text-[#7f919c]">
            <span className="font-black text-[#b9ff38]">Should still be there:</span>{' '}
            {model.likelyToReturn
              .map((row) => `${row.name} ${Math.round(row.survival)}%`)
              .join(' · ')}
          </p>
        )}
      </Panel>

      <Panel>
        <PanelTitle>Position drop-offs</PanelTitle>
        {model.cliffs.length === 0 ? (
          <EmptyNote>
            No position is thin enough right now to change what you do.
          </EmptyNote>
        ) : (
          <ul className="flex flex-col gap-2">
            {model.cliffs.map((cliff) => {
              const described = describeTierDepth({
                position: cliff.position,
                playersRemaining: cliff.playersRemainingInTier,
                gapAfterTier: cliff.gapAfterTier,
                weStartOne: cliff.weNeedIt,
                chanceOneRemains: cliff.tierSurvives,
              });
              return (
                <li
                  key={`${cliff.position}-${cliff.tier}`}
                  className={`rounded-lg border px-2.5 py-2 ${
                    cliff.weNeedIt
                      ? 'border-[#2a3c49] bg-[#111f28]'
                      : 'border-transparent bg-[#0a141c]'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <PositionTag position={cliff.position} size="sm" />
                    <span className="text-[11px] font-bold text-[#c3d1d9]">
                      {described.supply}
                    </span>
                    {cliff.weNeedIt && (
                      <span className="ml-auto text-[9px] font-black uppercase tracking-[0.08em] text-[#b9ff38]">
                        You need one
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[10.5px] leading-5 text-[#7f919c]">
                    {described.dropOff}
                    {cliff.tierSurvives !== null && (
                      <>
                        {' · '}
                        <span
                          style={{ color: SURVIVAL_COLOR[survivalTone(cliff.tierSurvives)] }}
                          className="font-bold"
                        >
                          {Math.round(cliff.tierSurvives)}% chance one is still there
                        </span>
                      </>
                    )}
                  </p>
                  <p className="mt-1 text-[10.5px] font-black uppercase tracking-[0.08em] text-[#6d8290]">
                    {described.advice}
                  </p>
                  {cliff.bestRemaining && (
                    <button
                      onClick={() => onOpenPlayer(cliff.bestRemaining!.playerId)}
                      className="mt-1 truncate text-[11px] font-bold text-[#8fa0aa] hover:text-[#e2e8eb]"
                    >
                      Best left: {cliff.bestRemaining.name}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel>
        <PanelTitle>Teams competing with you</PanelTitle>
        {model.threats.length === 0 ? (
          <EmptyNote>
            No team picking before your next selection needs a position you still
            have to fill.
          </EmptyNote>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {model.threats.map((threat) => (
              <li
                key={`${threat.rosterId}-${threat.selections[0]}`}
                className="rounded-lg bg-[#0a141c] px-2.5 py-2"
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[11.5px] font-bold text-[#c3d1d9]">
                    {threat.teamName}
                  </span>
                  <span className="shrink-0 text-[10px] font-bold tabular-nums text-[#5f7280]">
                    {threat.selections.map((pick) => `#${pick}`).join(' ')}
                  </span>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {threat.competingFor.map((entry) => (
                    <span key={entry.position} className="flex items-center gap-1">
                      <PositionTag position={entry.position} size="sm" />
                      {Math.round(entry.openStartingSlots) > 1 && (
                        <span className="text-[10px] font-bold text-[#5f7280]">
                          ×{formatSlots(entry.openStartingSlots)}
                        </span>
                      )}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {model.likelyBestAvailable.length > 0 && (
        <Panel>
          <PanelTitle
            action={
              model.runs !== null ? (
                <span className="text-[9px] font-bold text-[#3f4f5a]">
                  {model.runs} simulated drafts
                </span>
              ) : undefined
            }
          >
            Likely best available at your turn
          </PanelTitle>
          <ul className="flex flex-col gap-1">
            {model.likelyBestAvailable.map((entry) => (
              <li key={entry.playerId}>
                <button
                  onClick={() => onOpenPlayer(entry.playerId)}
                  className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left transition hover:bg-[#111f28]"
                >
                  <PositionTag position={entry.position} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-[#c3d1d9]">
                    {entry.name}
                  </span>
                  <span className="shrink-0 text-[10px] font-bold tabular-nums text-[#7f919c]">
                    {Math.round(entry.frequency)}%
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}
