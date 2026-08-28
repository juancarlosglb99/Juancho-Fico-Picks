'use client';

/**
 * Getting into a draft room, as four decisions instead of one wall of panels.
 *
 * Connect, choose a league, choose a draft, check it is right. The check is the
 * step the old screen did not have: everything the recommendation depends on is
 * verified here, once, while there is still time to fix it. "First Seed did not
 * load" is a five-second problem before a draft and an unrecoverable one during
 * it.
 *
 * Everything diagnostic lives behind a disclosure. The main path is four
 * buttons.
 */
import type { DraftReadiness } from '@/packages/ui/readiness';
import type { SleeperDraft, SleeperLeague } from '@/packages/sleeper/types';
import { Brand, ErrorBanner, LoadingMark, Panel, PanelTitle } from './primitives';
import { VerifyStep } from './pre-draft-verify';

export type PreDraftStep = 'connect' | 'league' | 'draft' | 'verify';

const STEPS: { id: PreDraftStep; label: string }[] = [
  { id: 'connect', label: 'Connect Sleeper' },
  { id: 'league', label: 'Choose league' },
  { id: 'draft', label: 'Choose draft' },
  { id: 'verify', label: 'Verify' },
];

export function PreDraft(props: {
  step: PreDraftStep;
  username: string;
  onUsernameChange: (value: string) => void;
  onConnect: (event: React.FormEvent<HTMLFormElement>) => void;
  onBack: (step: PreDraftStep) => void;
  busy: boolean;
  error: string | null;
  displayName: string | null;
  season: string | null;
  leagues: SleeperLeague[];
  onSelectLeague: (leagueId: string) => void;
  drafts: SleeperDraft[];
  discovered: SleeperDraft[];
  discoveryBusy: boolean;
  onSelectDraft: (draftId: string) => void;
  attachValue: string;
  onAttachValueChange: (value: string) => void;
  onAttach: () => void;
  attachError: string | null;
  readiness: DraftReadiness | null;
  readinessBusy: boolean;
  onEnter: () => void;
  onDetach: () => void;
  account?: {
    email: string | null;
    plan: string;
    creditsRemaining: number | null;
    onSignOut: () => void;
  } | null;
}) {
  return (
    <main className="min-h-screen bg-[#071019] text-[#f7f8f2]">
      <header className="border-b border-[#1c2b35] px-5 py-4">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4">
          <Brand />
          <div className="flex items-center gap-3">
            {props.displayName && (
              <span className="text-[11px] font-bold text-[#7f919c]">
                {props.displayName}
                {props.season ? ` · ${props.season}` : ''}
              </span>
            )}
            {props.account && (
              <span className="flex items-center gap-2 text-[11px] font-bold text-[#5f7280]">
                <span className="hidden sm:inline">{props.account.email}</span>
                <span className="rounded-full border border-[#25373f] px-2 py-0.5 uppercase tracking-[0.08em] text-[#8fa0aa]">
                  {props.account.plan}
                  {props.account.creditsRemaining !== null &&
                    ` · ${props.account.creditsRemaining}`}
                </span>
                <button
                  onClick={props.account.onSignOut}
                  className="transition hover:text-[#ff9a80]"
                >
                  Sign out
                </button>
              </span>
            )}
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-5xl px-5 py-6 sm:py-10">
        <Steps current={props.step} onBack={props.onBack} />
        {props.error && (
          <div className="mt-5">
            <ErrorBanner message={props.error} />
          </div>
        )}

        <div className="mt-6">
          {props.step === 'connect' && <ConnectStep {...props} />}
          {props.step === 'league' && <LeagueStep {...props} />}
          {props.step === 'draft' && <DraftStep {...props} />}
          {props.step === 'verify' && <VerifyStep {...props} />}
        </div>
      </div>
    </main>
  );
}

function Steps({
  current,
  onBack,
}: {
  current: PreDraftStep;
  onBack: (step: PreDraftStep) => void;
}) {
  const index = STEPS.findIndex((step) => step.id === current);
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {STEPS.map((step, position) => {
        const done = position < index;
        const active = position === index;
        return (
          <li key={step.id} className="flex items-center gap-2">
            <button
              disabled={!done}
              onClick={() => onBack(step.id)}
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.1em] transition ${
                active
                  ? 'bg-[#b9ff38] text-[#071019]'
                  : done
                    ? 'text-[#b9ff38] hover:bg-[#b9ff38]/10'
                    : 'text-[#3f4f5a]'
              }`}
            >
              <span className="tabular-nums">{position + 1}</span>
              {step.label}
            </button>
            {position < STEPS.length - 1 && <span className="text-[#25373f]">›</span>}
          </li>
        );
      })}
    </ol>
  );
}

function ConnectStep({
  username,
  onUsernameChange,
  onConnect,
  busy,
}: {
  username: string;
  onUsernameChange: (value: string) => void;
  onConnect: (event: React.FormEvent<HTMLFormElement>) => void;
  busy: boolean;
}) {
  return (
    <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)]">
      <div>
        <h1 className="max-w-xl text-4xl font-black leading-[1.02] tracking-[-0.05em] sm:text-5xl">
          Know who to draft
          <span className="block text-[#7f919c]">and who can wait.</span>
        </h1>
        <p className="mt-5 max-w-lg text-[15px] leading-7 text-[#a3b1ba]">
          Connect a Sleeper username to load your leagues, rosters and drafts.
          First Seed projections, Sleeper draft-room ranks and market ADP load
          automatically.
        </p>
        <form onSubmit={onConnect} className="mt-7 flex max-w-lg flex-col gap-2.5 sm:flex-row">
          <label className="sr-only" htmlFor="sleeper-username">
            Sleeper username
          </label>
          <input
            id="sleeper-username"
            name="username"
            value={username}
            onChange={(event) => onUsernameChange(event.target.value)}
            placeholder="Sleeper username"
            autoComplete="off"
            disabled={busy}
            className="h-12 flex-1 rounded-xl border border-[#2a3c49] bg-[#0c1822] px-4 text-[15px] font-semibold text-white outline-none placeholder:text-[#4d5c66] focus:border-[#b9ff38] disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={busy || !username.trim()}
            className="flex h-12 items-center justify-center gap-2 rounded-xl bg-[#b9ff38] px-6 text-[12px] font-black uppercase tracking-[0.08em] text-[#071019] transition hover:bg-[#cbff6e] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy && <LoadingMark />}
            {busy ? 'Connecting' : 'Connect'}
          </button>
        </form>
        <p className="mt-2.5 text-[11px] text-[#5f7280]">
          Read-only. No Sleeper password or token is required.
        </p>
      </div>

      <Panel className="hidden lg:block">
        <PanelTitle>What you get in the room</PanelTitle>
        <ul className="flex flex-col gap-2.5 text-[12.5px] leading-6 text-[#a3b1ba]">
          <li>· One recommendation, with the case against it.</li>
          <li>· Whether each player survives to your next selection.</li>
          <li>· A live draft board and your roster, side by side.</li>
          <li>· Deeper analysis on any player, when you ask for it.</li>
        </ul>
      </Panel>
    </div>
  );
}

function LeagueStep({
  leagues,
  onSelectLeague,
  busy,
  attachValue,
  onAttachValueChange,
  onAttach,
  attachError,
  season,
}: {
  leagues: SleeperLeague[];
  onSelectLeague: (leagueId: string) => void;
  busy: boolean;
  attachValue: string;
  onAttachValueChange: (value: string) => void;
  onAttach: () => void;
  attachError: string | null;
  season: string | null;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <PanelTitle>{season ? `${season} leagues` : 'Your leagues'}</PanelTitle>
        {leagues.length === 0 ? (
          <p className="py-2 text-[12.5px] leading-6 text-[#8fa0aa]">
            This account has no NFL league for the active season. You can still
            follow a mock draft with its link below.
          </p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {leagues.map((league) => (
              <li key={league.league_id}>
                <button
                  disabled={busy}
                  onClick={() => onSelectLeague(league.league_id)}
                  className="w-full rounded-xl border border-[#22333e] px-3 py-3 text-left transition hover:border-[#3d525f] disabled:opacity-50"
                >
                  <span className="block truncate text-[13.5px] font-black text-[#e2e8eb]">
                    {league.name}
                  </span>
                  <span className="mt-0.5 block text-[11px] font-bold text-[#5f7280]">
                    {league.total_rosters} teams · {league.status.replace('_', ' ')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <AttachPanel
        value={attachValue}
        onChange={onAttachValueChange}
        onAttach={onAttach}
        error={attachError}
        busy={busy}
      />
    </div>
  );
}

function DraftStep({
  drafts,
  discovered,
  discoveryBusy,
  onSelectDraft,
  busy,
  attachValue,
  onAttachValueChange,
  onAttach,
  attachError,
}: {
  drafts: SleeperDraft[];
  discovered: SleeperDraft[];
  discoveryBusy: boolean;
  onSelectDraft: (draftId: string) => void;
  busy: boolean;
  attachValue: string;
  onAttachValueChange: (value: string) => void;
  onAttach: () => void;
  attachError: string | null;
}) {
  const seen = new Set(drafts.map((draft) => draft.draft_id));
  const mocks = discovered.filter((draft) => !seen.has(draft.draft_id));

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <PanelTitle>League drafts</PanelTitle>
        {drafts.length === 0 ? (
          <p className="py-2 text-[12.5px] text-[#8fa0aa]">
            Sleeper does not expose a draft for this league.
          </p>
        ) : (
          <DraftList drafts={drafts} busy={busy} onSelect={onSelectDraft} />
        )}
      </Panel>

      <Panel>
        <PanelTitle
          action={discoveryBusy ? <LoadingMark className="h-3 w-3 text-[#5f7280]" /> : undefined}
        >
          Other drafts on this account
        </PanelTitle>
        {mocks.length === 0 ? (
          <p className="py-2 text-[12.5px] leading-6 text-[#8fa0aa]">
            {discoveryBusy
              ? 'Looking for mock drafts on this account…'
              : 'Sleeper only lists drafts you have joined. Start a mock in Sleeper, then paste its link below.'}
          </p>
        ) : (
          <DraftList drafts={mocks} busy={busy} onSelect={onSelectDraft} />
        )}
      </Panel>

      <AttachPanel
        value={attachValue}
        onChange={onAttachValueChange}
        onAttach={onAttach}
        error={attachError}
        busy={busy}
      />
    </div>
  );
}

function DraftList({
  drafts,
  busy,
  onSelect,
}: {
  drafts: SleeperDraft[];
  busy: boolean;
  onSelect: (draftId: string) => void;
}) {
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {drafts.map((draft) => (
        <li key={draft.draft_id}>
          <button
            disabled={busy}
            onClick={() => onSelect(draft.draft_id)}
            className="w-full rounded-xl border border-[#22333e] px-3 py-3 text-left transition hover:border-[#3d525f] disabled:opacity-50"
          >
            <span className="block truncate text-[13px] font-black text-[#e2e8eb]">
              {draft.metadata.name?.trim() || (draft.league_id ? 'League draft' : 'Mock draft')}
            </span>
            <span className="mt-0.5 block text-[11px] font-bold text-[#5f7280]">
              {draft.league_id ? 'League' : 'Mock'} · {draft.settings.teams ?? '?'} teams ·{' '}
              {draft.type} · {draft.status.replace('_', ' ')}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function AttachPanel({
  value,
  onChange,
  onAttach,
  error,
  busy,
}: {
  value: string;
  onChange: (value: string) => void;
  onAttach: () => void;
  error: string | null;
  busy: boolean;
}) {
  return (
    <Panel>
      <PanelTitle>Or paste a draft link</PanelTitle>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onAttach();
        }}
        className="flex flex-col gap-2 sm:flex-row"
      >
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="https://sleeper.com/draft/nfl/1234567890123456789"
          aria-label="Sleeper draft link or draft ID"
          spellCheck={false}
          className="h-11 w-full rounded-xl border border-[#22333e] bg-[#071019] px-3 text-[13px] font-semibold text-white outline-none placeholder:text-[#3f4f5a] focus:border-[#b9ff38]"
        />
        <button
          type="submit"
          disabled={busy}
          className="h-11 shrink-0 rounded-xl bg-[#b9ff38] px-5 text-[11px] font-black uppercase tracking-[0.08em] text-[#071019] transition hover:bg-[#cbff6e] disabled:opacity-50"
        >
          {busy ? 'Attaching…' : 'Attach'}
        </button>
      </form>
      {error && <p className="mt-2 text-[11.5px] font-semibold text-[#ff9b9b]">{error}</p>}
    </Panel>
  );
}

