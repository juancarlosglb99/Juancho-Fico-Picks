'use client';

/**
 * From a Sleeper snapshot to a recommendation, in one place.
 *
 * The chain is deliberately all derivation and no copied state: snapshot →
 * board → league context → recommendations → brief. A pick arriving from
 * Sleeper therefore re-derives the available pool, the roster, the
 * recommendations and the availability probabilities in the SAME render, with
 * no refresh step in between - which is the whole reason a pick becomes advice
 * in milliseconds rather than seconds.
 *
 * Each stage is timed, because the gap between a pick landing and the advice
 * changing is one of the two things this product is judged on.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { composeProjectionAndAdp } from '@/packages/data/projections';
import { normalizeLeagueContext } from '@/packages/engine/context/normalize';
import type { LeagueContext } from '@/packages/engine/context/types';
import { generateDraftRecommendations } from '@/packages/engine/draft/recommendations';
import { deriveDraftBoardState } from '@/packages/engine/draft/state';
import type { DraftBoardState, DraftRecommendationResult } from '@/packages/engine/draft/types';
import {
  LatencyRecorder,
  buildLatencySample,
  isNewlyObservedPick,
  measure,
  type LatencySummary,
  type ObservedBoard,
} from '@/packages/engine/perf/latency';
import { buildDraftBrief } from '@/packages/engine/strategist/brief';
import type { DraftBrief } from '@/packages/engine/strategist/types';
import type { CanonicalPlayerMap } from '@/packages/players/types';
import { buildDraftAttachment, type DraftAttachment } from '@/packages/sleeper/attachment';
import type {
  SleeperDraft,
  SleeperDraftPick,
  SleeperTradedPick,
} from '@/packages/sleeper/types';
import type { MappedProjection } from '@/packages/projections/types';
import { useDraftSources, type DraftSources } from './use-draft-sources';
import type { LiveDraftSnapshot } from './use-live-draft-sync';
import type { useSleeperSession } from './use-sleeper-session';

export interface DraftWorkspace {
  draft: SleeperDraft;
  picks: SleeperDraftPick[];
  tradedPicks: SleeperTradedPick[];
  players: CanonicalPlayerMap;
  board: DraftBoardState;
  /**
   * The league and rosters behind this draft - real for a league draft,
   * synthesized from the draft room for a mock, so both share one code path.
   */
  attachment: DraftAttachment;
  syncedAt: Date;
}

export interface DraftEngine {
  workspace: DraftWorkspace | null;
  context: LeagueContext | null;
  projections: MappedProjection[] | null;
  result: DraftRecommendationResult | null;
  brief: DraftBrief | null;
  sources: DraftSources;
  latency: LatencySummary | null;
}

export function useDraftEngine({
  session,
  snapshot,
}: {
  session: ReturnType<typeof useSleeperSession>;
  snapshot: LiveDraftSnapshot | null;
}): DraftEngine {
  const latencyRef = useRef<LatencyRecorder | null>(null);
  if (latencyRef.current === null) latencyRef.current = new LatencyRecorder();
  const observedRef = useRef<ObservedBoard | null>(null);
  const [latency, setLatency] = useState<LatencySummary | null>(null);

  const workspaceTimed = useMemo(() => {
    const bundle = session.attachment;
    if (!bundle) return null;

    // Ignore a snapshot belonging to a draft we are no longer attached to.
    const live = snapshot && snapshot.draft.draft_id === bundle.draftId ? snapshot : null;
    const source = live ?? bundle.initial;

    // Rebuilt from the CURRENT draft so a mock picks up its draft order as soon
    // as Sleeper publishes it, rather than being frozen at attach time.
    const attachment = buildDraftAttachment({
      draft: source.draft,
      league: bundle.league,
      rosters: bundle.rosters,
    });
    const { value: board, ms } = measure(() =>
      deriveDraftBoardState(source.draft, source.picks, attachment.rosters, bundle.players),
    );
    return {
      ms,
      value: {
        draft: source.draft,
        picks: source.picks,
        tradedPicks: source.tradedPicks,
        players: bundle.players,
        attachment,
        board,
        syncedAt: new Date(source.fetchedAt),
      } satisfies DraftWorkspace,
    };
  }, [session.attachment, snapshot]);
  const workspace = workspaceTimed?.value ?? null;

  const userId = session.user?.user_id ?? null;
  const leagueDrafts = session.workspace?.drafts ?? null;

  const contextTimed = useMemo(() => {
    if (!workspace || !userId) return null;
    const { value, ms } = measure(() =>
      normalizeLeagueContext({
        league: workspace.attachment.league,
        draft: workspace.draft,
        drafts: leagueDrafts ?? [workspace.draft],
        picks: workspace.picks,
        tradedPicks: workspace.tradedPicks,
        rosters: workspace.attachment.rosters,
        board: workspace.board,
        userId,
        overrides: {},
      }),
    );
    return { value, ms };
  }, [workspace, leagueDrafts, userId]);
  const context = contextTimed?.value ?? null;

  const sources = useDraftSources({
    season: session.season,
    draftSeason: workspace?.draft.season ?? null,
    draftId: workspace?.draft.draft_id ?? null,
    players: workspace?.players ?? null,
    context,
  });

  const projections = useMemo(
    () => (sources.projections ? composeProjectionAndAdp(sources.projections, sources.adp) : null),
    [sources.projections, sources.adp],
  );

  const resultTimed = useMemo(() => {
    if (!workspace || !projections || !context || workspace.draft.status === 'complete') {
      return null;
    }
    const { value, ms } = measure(() =>
      generateDraftRecommendations({
        context,
        picks: workspace.picks,
        rosters: workspace.attachment.rosters,
        board: workspace.board,
        players: workspace.players,
        projections,
        roomRankings: sources.roomRankings,
      }),
    );
    return { value, ms };
  }, [workspace, projections, context, sources.roomRankings]);
  const result = resultTimed?.value ?? null;

  /*
   * The brief costs a few object allocations - it is assembled from state the
   * engine already computed - and it stays out of the path that puts a
   * recommendation on screen.
   */
  const brief = useMemo(() => {
    if (!workspace || !context || !result) return null;
    return buildDraftBrief({
      context,
      board: workspace.board,
      picks: workspace.picks,
      rosters: workspace.attachment.rosters,
      players: workspace.players,
      result,
      draftId: workspace.draft.draft_id,
      isMock: workspace.attachment.source === 'mock',
    });
  }, [workspace, context, result]);

  /*
   * One sample per pick that actually moved the board. `last_picked` is
   * Sleeper's own timestamp, so this measures how stale our advice was rather
   * than merely how long our own code took.
   */
  useEffect(() => {
    if (!snapshot || !workspace || !resultTimed) return;
    const recorder = latencyRef.current;
    if (!recorder) return;

    const current: ObservedBoard = {
      draftId: workspace.draft.draft_id,
      picksMade: workspace.board.picksMade,
    };
    const previous = observedRef.current;
    observedRef.current = current;

    if (previous && previous.draftId !== current.draftId) {
      recorder.clear();
      setLatency(null);
    }
    if (!isNewlyObservedPick(previous, current)) return;

    recorder.record(
      buildLatencySample({
        overallPick: workspace.board.currentOverallPick,
        pickedAt: snapshot.draft.last_picked,
        fetchedAt: snapshot.fetchedAt,
        computeMs:
          (workspaceTimed?.ms ?? 0) + (contextTimed?.ms ?? 0) + resultTimed.ms,
      }),
    );
    setLatency(recorder.summary());
  }, [snapshot, workspace, workspaceTimed, contextTimed, resultTimed]);

  return { workspace, context, projections, result, brief, sources, latency };
}
