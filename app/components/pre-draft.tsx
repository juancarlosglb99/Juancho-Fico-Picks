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
import Link from 'next/link';
import type { DraftReadiness } from '@/packages/ui/readiness';
import type { SleeperDraft, SleeperLeague } from '@/packages/sleeper/types';
import { Brand, ErrorBanner, LoadingMark, Panel, PanelTitle } from './primitives';
import { VerifyStep } from './pre-draft-verify';
import { buildDraftChoices, needsLeagueFallback } from '@/packages/ui/draft-picker';

export type PreDraftStep = 'connect' | 'league' | 'draft' | 'verify';

/*
 * Three steps, not four. Choosing a league was Sleeper's data model showing
 * through: a drafter is thinking "the Escorpiones draft is tonight", not
 * "which league contains it". The league is resolved behind the draft.
 */
const STEPS: { id: PreDraftStep; label: string }[] = [
  { id: 'connect', label: 'Connect Sleeper' },
  { id: 'draft', label: 'Select a draft' },
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
  /** The fallback, for a league whose drafts Sleeper did not return. */
  onBrowseLeagues: () => void;
  userId: string | null;
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
    /**
     * Whether to offer the admin dashboard. Decided by `isAdmin` over the
     * server's own summary - this component never infers it from the plan
     * string it prints.
     */
    isAdmin: boolean;
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
                <PlanBadge
                  plan={props.account.plan}
                  creditsRemaining={props.account.creditsRemaining}
                  isAdmin={props.account.isAdmin}
                />
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

/*
 * The plan badge, which for an admin is also the way in to the admin page.
 *
 * That page was reachable only by typing the URL. The badge already said
 * ADMIN, in the right place, to exactly the right people - so it becomes the
 * link rather than the header growing a control beside it.
 *
 * `isAdmin` is decided by the server's summary, never inferred from the plan
 * string printed here. A link is not permission either way: `/admin` fetches
 * from routes that answer 404 to anybody the entitlement table does not call
 * an admin.
 */
const BADGE_SHAPE = 'rounded-full border px-2 py-0.5 uppercase tracking-[0.08em]';
const BADGE_TONE = 'border-[#25373f] text-[#8fa0aa]';

function PlanBadge({
  plan,
  creditsRemaining,
  isAdmin,
}: {
  plan: string;
  creditsRemaining: number | null;
  isAdmin: boolean;
}) {
  const label = `${plan}${creditsRemaining !== null ? ` · ${creditsRemaining}` : ''}`;

  if (!isAdmin) {
    return <span className={`${BADGE_SHAPE} ${BADGE_TONE}`}>{label}</span>;
  }

  return (
    <Link
      href="/admin"
      title="Open the admin dashboard"
      className={`${BADGE_SHAPE} ${BADGE_TONE} transition hover:border-[#b9ff38] hover:text-[#b9ff38] focus-visible:border-[#b9ff38] focus-visible:text-[#b9ff38] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b9ff38]/60`}
    >
      {label}
    </Link>
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
          <li>· The chance each player is still there at your next pick.</li>
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
  onBrowseLeagues,
  userId,
  leagues,
}: {
  drafts: SleeperDraft[];
  discovered: SleeperDraft[];
  discoveryBusy: boolean;
  onSelectDraft: (draftId: string) => void;
  onBrowseLeagues: () => void;
  userId: string | null;
  leagues: SleeperLeague[];
  busy: boolean;
  attachValue: string;
  onAttachValueChange: (value: string) => void;
  onAttach: () => void;
  attachError: string | null;
}) {
  /*
   * One list. `discovered` is `/user/{id}/drafts`, which overlaps heavily with
   * `drafts` - the two panels this replaces were splitting one answer in half
   * because the old flow had arrived from a league. Neither source reliably
   * lists mocks, which is why the paste field exists alongside them.
   */
  const seen = new Set<string>();
  const all = [...discovered, ...drafts].filter((draft) => {
    if (seen.has(draft.draft_id)) return false;
    seen.add(draft.draft_id);
    return true;
  });
  const choices = buildDraftChoices({ drafts: all, leagues, userId });
  const showLeagueFallback = needsLeagueFallback({ choices, leagues });

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <PanelTitle
          action={discoveryBusy ? <LoadingMark className="h-3 w-3 text-[#5f7280]" /> : undefined}
        >
          Your drafts
        </PanelTitle>
        {choices.length === 0 ? (
          <p className="py-2 text-[12.5px] leading-6 text-[#8fa0aa]">
            {discoveryBusy
              ? 'Looking for your drafts…'
              : 'Sleeper only lists drafts you have joined. Start one in Sleeper, then paste its link below.'}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {choices.map((choice) => (
              <li key={choice.draftId}>
                <button
                  onClick={() => onSelectDraft(choice.draftId)}
                  disabled={busy}
                  className="flex w-full items-center justify-between gap-3 rounded-xl border border-[#22333e] bg-[#0a141c] px-3.5 py-3 text-left transition hover:border-[#3c5261] disabled:opacity-50"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[14px] font-black tracking-[-0.02em] text-[#f7f8f2]">
                      {choice.title}
                    </span>
                    <span className="mt-0.5 block truncate text-[12px] font-semibold text-[#8fa0aa]">
                      {choice.subtitle || choice.kindLabel}
                    </span>
                    {/* The kind is words, never a colour on its own. */}
                    <span className="mt-1 block text-[10px] font-black uppercase tracking-[0.11em] text-[#5f7280]">
                      {choice.kindLabel}
                      {choice.leagueHasSiblings ? ' · this league has more than one' : ''}
                    </span>
                  </span>
                  <span className="shrink-0 rounded-lg bg-[#132030] px-3 py-2 text-[11.5px] font-black text-[#c3d1d9]">
                    {choice.cta}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {showLeagueFallback && (
          <p className="mt-3 text-[12px] leading-6 text-[#8fa0aa]">
            Missing one?{' '}
            <button
              type="button"
              onClick={onBrowseLeagues}
              className="font-bold text-[#b9ff38] underline-offset-2 hover:underline"
            >
              Browse by league
            </button>{' '}
            - Sleeper does not always list a league&apos;s draft here.
          </p>
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

