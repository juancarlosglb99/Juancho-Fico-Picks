'use client';

/**
 * The whole product, composed.
 *
 * This file holds no layout and no fantasy logic. It wires the Sleeper session
 * and the data sources into the engine, turns the engine's output into the
 * handful of view models in `packages/ui`, and hands those to the draft room.
 * Everything worth testing therefore lives somewhere a test can reach without a
 * browser.
 *
 * The ordering that matters is unchanged: the board is DERIVED from the newest
 * snapshot, the deterministic recommendation is derived from the board, and the
 * strategist runs alongside - never in front of - that path.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { jointOutcome } from '@/packages/engine/draft/joint-availability';
import { runMonteCarloCandidateComparison } from '@/packages/engine/mock/simulation';
import { parseSleeperDraftRef } from '@/packages/sleeper/draft-ref';
import { buildDraftBoard } from '@/packages/ui/draft-board';
import { deriveMyTeam } from '@/packages/ui/my-team';
import { buildNextUp } from '@/packages/ui/next-up';
import { buildPlayerAnalysis } from '@/packages/ui/player-analysis';
import { tierSurvivalOf } from '@/packages/ui/player-analysis-outlook';
import { buildPlayerPool } from '@/packages/ui/player-pool';
import { buildDraftReadiness } from '@/packages/ui/readiness';
import { resolveRecommendationCard } from '@/packages/ui/recommendation';
import { deriveDraftStatus } from '@/packages/ui/status';
import { screenForUrl } from '@/packages/ui/auth-flow';
import type { LeagueRosterView } from '@/packages/sleeper/types';
import { DiagnosticsPanel, diagnosticsEnabled } from './components/diagnostics';
import { DraftRoom } from './components/draft-room';
import { PlayerCompare } from './components/player-compare';
import { PlayerDrawer, type SimulationState } from './components/player-drawer';
import { PreDraft, type PreDraftStep } from './components/pre-draft';
import { ErrorBanner, Notice } from './components/primitives';
import { FakeStrategistTransport, parseFakeStrategist } from './fake-strategist';
import { signOut } from './auth-client';
import { AuthScreenView } from './components/auth-screen';
import { PendingScreen } from './components/pending-screen';
import { useAccount } from './use-account';
import { useDraftEngine } from './use-draft-engine';
import { useLiveDraftSync } from './use-live-draft-sync';
import { useSleeperSession } from './use-sleeper-session';
import { useStrategist } from './use-strategist';

/** How many complete draft continuations the on-demand simulation runs. */
const SIMULATION_RUNS = 60;
const IDLE_SIMULATION: SimulationState = {
  status: 'idle',
  candidates: [],
  simulations: 0,
  message: null,
};

export function Dashboard() {
  const session = useSleeperSession();
  const account = useAccount();
  const [username, setUsername] = useState('');
  const [attachInput, setAttachInput] = useState('');
  const [entered, setEntered] = useState(false);
  const [aiAvailable, setAiAvailable] = useState<boolean | null>(null);
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [simulation, setSimulation] = useState<SimulationState>(IDLE_SIMULATION);
  const [now, setNow] = useState(() => Date.now());

  /*
   * Read once, from the URL. Both are development affordances: `?diagnostics=1`
   * reveals the engine's internals, `?ai=confirmed|override|analyzing|fallback`
   * summons a strategist state with a fake transport.
   */
  const [search] = useState(() =>
    typeof window === 'undefined' ? '' : window.location.search,
  );
  const showDiagnostics = diagnosticsEnabled(search);
  const fakeStrategistMode = showDiagnostics ? parseFakeStrategist(search) : null;

  const { snapshot: liveSnapshot, syncState } = useLiveDraftSync(session.attachedDraftId);

  /* The clock in the status bar counts elapsed time, so it needs a tick. */
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  /* Whether a strategist is configured. Asked once; never carries a key. */
  useEffect(() => {
    let cancelled = false;
    void fetch('/api/strategist')
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        /*
         * `available` is configured AND switched on, so a deployment with the
         * kill switch pulled says "no AI" up front rather than offering a
         * feature that will decline every request.
         */
        const status = body as { configured?: boolean; available?: boolean } | null;
        if (!cancelled) setAiAvailable(Boolean(status?.available ?? status?.configured));
      })
      .catch(() => {
        if (!cancelled) setAiAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const { workspace, context, projections, result, brief, sources, latency } = useDraftEngine({
    session,
    snapshot: liveSnapshot,
  });

  /*
   * Alongside, never in front: the card is already on screen when this starts.
   *
   * The fake transport exists only so the AI states can be looked at without
   * spending anything, and it is unreachable unless diagnostics are on.
   */
  const strategistOptions = useMemo(() => {
    if (!fakeStrategistMode) return {};
    return {
      transport: new FakeStrategistTransport(fakeStrategistMode),
      /*
       * The real policy asks only when we are on the clock, which makes the AI
       * states impossible to look at on any board but our own turn. The fake
       * costs nothing, so it answers about any board.
       */
      policy: { cadence: 'approaching_turn' as const, analyzeWithin: 999 },
    };
  }, [fakeStrategistMode]);
  const strategist = useStrategist(entered ? brief : null, {
    ...strategistOptions,
    leagueId: workspace?.attachment.league.league_id ?? null,
  });

  /* ------------------------------------------------------------ view models */

  const status = useMemo(() => {
    if (!workspace || !context) return null;
    return deriveDraftStatus({
      draft: workspace.draft,
      board: workspace.board,
      context,
      syncState,
      syncedAtMs: workspace.syncedAt.getTime(),
      leagueName: workspace.attachment.league.name,
      isMock: workspace.attachment.source === 'mock',
      now,
    });
  }, [workspace, context, syncState, now]);

  const myTeam = useMemo(() => {
    if (!workspace || !context) return null;
    const points = new Map<string, number>();
    for (const projection of projections ?? []) {
      points.set(projection.playerId, projection.projection);
    }
    return deriveMyTeam({
      rosterId: context.draftState.value.userRosterId,
      picks: workspace.picks,
      rosters: workspace.attachment.rosters,
      players: workspace.players,
      projections: points,
      roster: context.roster.value,
      benchSlots: context.roster.value.bench,
      slotToRosterId: workspace.draft.slot_to_roster_id,
    });
  }, [workspace, context, projections]);

  /**
   * Who the other teams are.
   *
   * Real owners for a league draft, seats for a mock. A mock has no league at
   * all, so reading the last league's roster views would put another league's
   * owners on this board - and label somebody else's seat as ours.
   */
  const rosterViews = useMemo<LeagueRosterView[]>(() => {
    if (!workspace) return [];
    const loaded = session.workspace;
    if (
      workspace.attachment.source === 'league' &&
      loaded &&
      loaded.league.league_id === workspace.attachment.league.league_id
    ) {
      return loaded.rosterViews;
    }
    return workspace.attachment.rosters.map((roster, index) => {
      const mine = roster.owner_id !== null && roster.owner_id === session.user?.user_id;
      const label = mine
        ? session.user?.display_name || session.user?.username || 'Your team'
        : `Seat ${index + 1}`;
      return { roster, owner: null, displayName: label, teamName: label };
    });
  }, [workspace, session.workspace, session.user]);

  const teamNameFor = useCallback(
    (rosterId: number | null) =>
      rosterId === null
        ? null
        : rosterViews.find((view) => view.roster.roster_id === rosterId)?.teamName ?? null,
    [rosterViews],
  );

  const boardModel = useMemo(() => {
    if (!workspace || !context) return null;
    return buildDraftBoard({
      picks: workspace.picks,
      teams: workspace.board.teams,
      rounds: workspace.board.rounds,
      draftType: context.draftType.value,
      currentOverallPick: workspace.board.currentOverallPick,
      players: workspace.players,
      slotToRosterId: workspace.draft.slot_to_roster_id,
      ourRosterId: context.draftState.value.userRosterId,
      ourDraftSlot: context.draftState.value.userDraftSlot,
      teamNameFor: (rosterId, draftSlot) => teamNameFor(rosterId) ?? `Seat ${draftSlot}`,
    });
  }, [workspace, context, teamNameFor]);

  const pool = useMemo(() => (result ? buildPlayerPool(result) : []), [result]);
  const nextUp = useMemo(
    () => (result ? buildNextUp({ result, brief, teamNameFor }) : null),
    [result, brief, teamNameFor],
  );

  const nameOf = useCallback(
    (playerId: string) => {
      const player = result?.internals?.playerOf(playerId);
      return player ? { name: player.name, position: player.position } : null;
    },
    [result],
  );

  const card = useMemo(
    () =>
      resolveRecommendationCard({
        result,
        strategist,
        currentFingerprint: brief?.state.boardFingerprint ?? null,
        nameOf,
        survivalOf: (playerId) => {
          const estimate = result?.internals?.survivalOf(playerId);
          return estimate?.modeled ? estimate.value : null;
        },
        tierGapOf: (playerId) => result?.internals?.tierOf(playerId)?.gapAfterTier ?? null,
        tierSurvivesOf: (playerId) =>
          result?.internals ? tierSurvivalOf(result.internals, playerId) : null,
      }),
    [result, strategist, brief, nameOf],
  );

  const draftedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const sleeperId of workspace?.board.unavailableSleeperIds ?? []) {
      const player = workspace?.players.bySleeperId.get(sleeperId);
      if (player) ids.add(player.id);
    }
    return ids;
  }, [workspace]);

  const analysisFor = useCallback(
    (playerId: string) =>
      result
        ? buildPlayerAnalysis({
            playerId,
            result,
            brief,
            draftedPlayerIds: draftedIds,
            teamNameFor,
          })
        : null,
    [result, brief, draftedIds, teamNameFor],
  );

  const selectedAnalysis = useMemo(
    () => (selectedPlayerId ? analysisFor(selectedPlayerId) : null),
    [selectedPlayerId, analysisFor],
  );
  const compareAnalyses = useMemo(
    () => compareIds.map(analysisFor).filter((analysis) => analysis !== null),
    [compareIds, analysisFor],
  );

  const readiness = useMemo(() => {
    if (!workspace || !context) return null;
    const ourRosterId = context.draftState.value.userRosterId;
    return buildDraftReadiness({
      attachment: workspace.attachment,
      draft: workspace.draft,
      context,
      projections: sources.projections,
      roomRankings: sources.roomRankings,
      adp: sources.adp,
      ourTeamName: teamNameFor(ourRosterId) ?? session.user?.display_name ?? null,
      ai: {
        configured: aiAvailable,
        accountsEnabled: account.accountsEnabled,
        plan: account.plan,
        creditsRemaining: account.creditsRemaining,
      },
    });
  }, [workspace, context, sources, teamNameFor, session.user, aiAvailable, account]);

  /* --------------------------------------------------------------- actions */

  const openPlayer = useCallback((playerId: string) => {
    setCompareIds([]);
    setSelectedPlayerId(playerId);
    setSimulation(IDLE_SIMULATION);
  }, []);

  const toggleCompare = useCallback((playerId: string) => {
    setCompareIds((current) =>
      current.includes(playerId)
        ? current.filter((id) => id !== playerId)
        : // Three is the most a person compares at once before the table stops
          // being readable on a phone.
          [...current, playerId].slice(-3),
    );
  }, []);

  const runSimulation = useCallback(
    async (playerId: string) => {
      if (!workspace || !context || !projections || !result) {
        setSimulation({
          status: 'unavailable',
          candidates: [],
          simulations: 0,
          message: 'The simulation needs a live board and a projection source.',
        });
        return;
      }
      setSimulation({ status: 'running', candidates: [], simulations: 0, message: null });
      // Yield once so the button can paint its running state before the work.
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      try {
        const rivals = result.recommendations
          .map((recommendation) => recommendation.player.id)
          .filter((id) => id !== playerId)
          .slice(0, 2);
        const comparison = runMonteCarloCandidateComparison(
          {
            context,
            draft: workspace.draft,
            board: workspace.board,
            picks: workspace.picks,
            rosters: workspace.attachment.rosters,
            players: workspace.players,
            projections,
            roomRankings: sources.roomRankings,
          },
          [playerId, ...rivals],
          { simulations: SIMULATION_RUNS },
        );
        setSimulation({
          status: 'ready',
          candidates: comparison.candidates,
          simulations: comparison.simulationsPerCandidate,
          message: null,
        });
      } catch (error) {
        setSimulation({
          status: 'unavailable',
          candidates: [],
          simulations: 0,
          message: error instanceof Error ? error.message : 'The simulation failed.',
        });
      }
    },
    [workspace, context, projections, result, sources.roomRankings],
  );

  const attachFromInput = useCallback(() => {
    const parsed = parseSleeperDraftRef(attachInput);
    if (!parsed.ok) {
      session.setAttachError(parsed.message);
      return;
    }
    session.setAttachError(null);
    void session.attachToDraft(parsed.ref.draftId, session.workspace);
  }, [attachInput, session]);

  const leaveRoom = useCallback(() => {
    setEntered(false);
    setSelectedPlayerId(null);
    setCompareIds([]);
  }, []);

  /* ----------------------------------------------------------------- render */

  /*
   * A deployment that started past its own preflight. The container refuses to
   * boot when this list is non-empty, so reaching here means something bypassed
   * that - and serving an application with no authorisation behind it is the
   * one outcome worth a blank screen.
   */
  if (account.misconfigured.length > 0) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#071019] px-5 text-[#f7f8f2]">
        <div className="max-w-xl">
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-[#ff9a80]">
            Server not configured
          </p>
          <h1 className="mt-3 text-2xl font-black tracking-[-0.03em]">
            This deployment is missing required configuration.
          </h1>
          <ul className="mt-4 flex flex-col gap-2">
            {account.misconfigured.map((problem) => (
              <li key={problem} className="text-[13px] leading-6 text-[#a3b1ba]">
                · {problem}
              </li>
            ))}
          </ul>
        </div>
      </main>
    );
  }

  /*
   * Accounts gate the product only where they exist. With no database this is a
   * local single-user deployment, and the draft room opens as it always did -
   * production refuses to start in that state, so it can never be that here.
   */
  if (account.accountsEnabled && !account.signedIn && !account.loading) {
    const requested = screenForUrl(search);
    return (
      <AuthScreenView
        initialScreen={requested.screen}
        resetToken={requested.token}
        onSignedIn={account.refresh}
      />
    );
  }

  /*
   * Registered, not yet activated. The beta's gate is a person, so this is a
   * real state and not an error - and it must not look like a broken product.
   */
  if (
    account.accountsEnabled &&
    account.signedIn &&
    !account.loading &&
    account.access !== 'active'
  ) {
    return (
      <PendingScreen
        email={account.user?.email ?? null}
        revoked={account.access === 'revoked'}
        onSignOut={() => {
          void signOut().then(() => account.refresh());
        }}
      />
    );
  }

  const step: PreDraftStep = !session.user
    ? 'connect'
    : session.attachment
      ? 'verify'
      : session.workspace
        ? 'draft'
        : 'league';

  if (!entered || !workspace || !context || !status || !myTeam || !boardModel) {
    return (
      <PreDraft
        step={step}
        username={username}
        onUsernameChange={setUsername}
        onConnect={(event) => {
          event.preventDefault();
          void session.connect(username);
        }}
        onBack={(target) => {
          if (target === 'connect') session.reset();
          if (target === 'league') session.detach();
          if (target === 'draft') session.detach();
        }}
        busy={session.busy !== null}
        error={session.error}
        displayName={session.user?.display_name ?? session.user?.username ?? null}
        season={session.season}
        leagues={session.leagues}
        onSelectLeague={(leagueId) => void session.loadLeague(leagueId)}
        drafts={session.workspace?.drafts ?? []}
        discovered={session.discoveredDrafts}
        discoveryBusy={session.discoveryBusy}
        onSelectDraft={(draftId) => void session.attachToDraft(draftId, session.workspace)}
        attachValue={attachInput}
        onAttachValueChange={setAttachInput}
        onAttach={attachFromInput}
        attachError={session.attachError}
        readiness={readiness}
        readinessBusy={sources.loading}
        onEnter={() => setEntered(true)}
        onDetach={session.detach}
        account={
          account.accountsEnabled && account.signedIn
            ? {
                email: account.user?.email ?? null,
                plan: account.plan,
                creditsRemaining: account.creditsRemaining,
                onSignOut: () => {
                  void signOut().then(() => account.refresh());
                },
              }
            : null
        }
      />
    );
  }

  return (
    <>
      <DraftRoom
        status={status}
        card={card}
        team={myTeam}
        nextUp={nextUp}
        pool={pool}
        board={boardModel}
        draftType={context.draftType.value}
        compareIds={compareIds}
        onOpenPlayer={openPlayer}
        onToggleCompare={toggleCompare}
        onCompare={(ids) => {
          setSelectedPlayerId(null);
          setCompareIds(ids.slice(0, 3));
        }}
        onLeave={leaveRoom}
        showSpend={showDiagnostics}
        headerActions={
          compareIds.length > 0 ? (
            <button
              onClick={() => setSelectedPlayerId(null)}
              className="rounded-full border border-[#b9ff38]/40 px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.1em] text-[#b9ff38]"
            >
              Compare {compareIds.length}
            </button>
          ) : undefined
        }
        banner={
          result ? undefined : workspace.draft.status === 'complete' ? (
            <Notice message="This draft is complete. The board below is final, and no further advice is given." />
          ) : sources.projectionError ? (
            <ErrorBanner message={sources.projectionError} />
          ) : (
            <Notice message="Loading the projection source. The board and your roster are already live." />
          )
        }
        footer={
          showDiagnostics ? (
            <DiagnosticsPanel
              projections={sources.projections}
              roomRankings={sources.roomRankings}
              adp={sources.adp}
              context={context}
              recommendation={result?.recommendations[0] ?? null}
              latency={latency}
              syncState={syncState}
              onRetrySources={sources.retryAll}
              onImportCsv={(event) => void sources.importCsv(event)}
              onRestoreAutomatic={sources.restoreAutomatic}
              usingCustomProjections={sources.projectionMode === 'custom'}
              account={{
                accountsEnabled: account.accountsEnabled,
                signedIn: account.signedIn,
                plan: account.plan,
                creditsRemaining: account.creditsRemaining,
              }}
            />
          ) : undefined
        }
      />

      <PlayerDrawer
        analysis={selectedAnalysis}
        open={selectedPlayerId !== null && selectedAnalysis !== null}
        onClose={() => setSelectedPlayerId(null)}
        onOpenPlayer={openPlayer}
        simulation={simulation}
        onRunSimulation={(playerId) => void runSimulation(playerId)}
        nameOf={(playerId) => nameOf(playerId)?.name ?? playerId}
      />

      <PlayerCompare
        analyses={compareAnalyses}
        open={compareIds.length > 0 && selectedPlayerId === null}
        onClose={() => setCompareIds([])}
        onOpenPlayer={openPlayer}
        onRemove={(playerId) =>
          setCompareIds((current) => current.filter((id) => id !== playerId))
        }
        jointFor={(a, b) => {
          const outcomes = result?.internals?.roomOutcomes;
          return outcomes ? jointOutcome(outcomes, a, b) : null;
        }}
      />
    </>
  );
}
