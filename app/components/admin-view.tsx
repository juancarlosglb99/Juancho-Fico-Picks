'use client';

/**
 * Running the beta without SSH.
 *
 * Operational rather than developer-facing: the questions it answers are "who
 * is waiting", "what did they ask for", "what have they cost", and "is the AI
 * still switched on". It is not a database browser.
 *
 * SECURITY. Nothing on this page authorises anything. Every fetch goes to a
 * route that resolves the caller from their session cookie and reads the
 * entitlement table, and those routes answer 404 to anybody who is not an
 * admin - so this component rendering is not evidence of permission, and the
 * empty state below is what a non-admin sees. There is no `admin` flag in any
 * request body, because there is nothing a browser could send that would help.
 *
 * The AI controls are a VIEW over the existing server-side switch, not a second
 * one. `scripts/account.mjs ai …` writes the same row.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  actionsFor,
  creditsLeft,
  describeAccountStatus,
  describeRequest,
  formatSpend,
  formatWhen,
  type AdminAccount,
} from '@/packages/ui/admin';
import { Brand, EmptyNote, ErrorBanner, Panel, PanelTitle } from './primitives';

interface AiControls {
  enabled: boolean;
  disabledReason: string | null;
  environmentKillSwitch: boolean;
  spendTodayUsd: number;
  spendMonthUsd: number;
  dailyCapUsd: number;
  monthlyCapUsd: number;
  perDraftCapUsd: number;
  maxCallsPerDraft: number;
  maxRepairsPerDraft: number;
  inFlight: number;
  attempts?: {
    createdAt: string;
    sleeperDraftId: string;
    selectionKey: string | null;
    attemptIndex: number;
    isRepair: boolean;
    outcome: string;
    stopReason: string | null;
    hadToolUse: boolean;
    toolInputKeyCount: number | null;
    validationFaults: string[];
    providerStatus: number | null;
    providerErrorType: string | null;
    estimatedCostUsd: number;
    latencyMs: number | null;
    email: string;
  }[];
}

const STATUS_TONE = {
  waiting: { border: '#3a3320', text: '#e0a13c' },
  active: { border: '#3d5a1f', text: '#b9ff38' },
  stopped: { border: '#3d2020', text: '#ff9a80' },
} as const;

export function AdminView() {
  const [accounts, setAccounts] = useState<AdminAccount[] | null>(null);
  const [ai, setAi] = useState<AiControls | null>(null);
  const [search, setSearch] = useState('');
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  /*
   * Both loaders own their own failure. Nothing here throws back into the
   * caller, so the effect below has no error callback of its own - and every
   * state update happens after an await, never while React is committing.
   */
  const loadUsers = useCallback(async (q: string) => {
    try {
      const response = await fetch(`/api/admin/users?q=${encodeURIComponent(q)}`, {
        credentials: 'same-origin',
      });
      // 404 rather than 403: whether this page exists is not a customer's
      // business, and the server answers the same way to both questions.
      if (response.status === 404) {
        setForbidden(true);
        return;
      }
      const body = (await response.json()) as { users?: AdminAccount[] };
      setAccounts(body.users ?? []);
    } catch {
      setError('Could not load accounts.');
    }
  }, []);

  const loadAi = useCallback(async () => {
    try {
      const response = await fetch('/api/admin/ai', { credentials: 'same-origin' });
      if (!response.ok) return;
      setAi((await response.json()) as AiControls);
    } catch {
      /* The account list is the page; the controls panel simply stays hidden. */
    }
  }, []);

  useEffect(() => {
    /*
     * The rule cannot see through an async function boundary. Both loaders run
     * synchronously only as far as their first `await fetch(...)`, so every
     * state update in them happens after the effect has returned - which is
     * exactly what the rule is asking for.
     */
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadUsers('');
    void loadAi();
  }, [loadUsers, loadAi]);

  const act = async (userId: string, action: string, credits?: number) => {
    setBusy(`${userId}:${action}:${credits ?? ''}`);
    setError(null);
    try {
      const response = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ userId, action, credits }),
      });
      const body = (await response.json()) as { users?: AdminAccount[]; error?: string };
      if (!response.ok) {
        setError(body.error ?? 'That action did not work.');
        return;
      }
      if (body.users) setAccounts(body.users);
    } catch {
      setError('That action did not work.');
    } finally {
      setBusy(null);
    }
  };

  const aiAct = async (action: string, payload: Record<string, unknown> = {}) => {
    setBusy(`ai:${action}`);
    try {
      const response = await fetch('/api/admin/ai', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action, ...payload }),
      });
      const body = (await response.json()) as AiControls & { error?: string };
      if (!response.ok) {
        setError(body.error ?? 'That did not work.');
        return;
      }
      setAi(body);
    } finally {
      setBusy(null);
    }
  };

  if (forbidden) {
    return (
      <Shell>
        <Panel className="p-6">
          <h1 className="text-xl font-black tracking-[-0.03em]">Not found.</h1>
          <p className="mt-2 text-[14px] leading-7 text-[#a3b1ba]">
            There is nothing here for this account.
          </p>
        </Panel>
      </Shell>
    );
  }

  const waiting = (accounts ?? []).filter(
    (account) => describeAccountStatus(account).tone === 'waiting',
  ).length;

  return (
    <Shell>
      {error && (
        <div className="mb-4">
          <ErrorBanner message={error} />
        </div>
      )}

      {ai && <AiPanel ai={ai} busy={busy} onAct={aiAct} />}

      <Panel className="mt-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <PanelTitle>
            Accounts{waiting > 0 ? ` · ${waiting} waiting` : ''}
          </PanelTitle>
          <input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              void loadUsers(event.target.value);
            }}
            placeholder="Search by email or name"
            className="w-full max-w-xs rounded-lg border border-[#22333e] bg-[#0a141c] px-3 py-2 text-[13px] text-[#f7f8f2] outline-none placeholder:text-[#5f7280] focus:border-[#3c5261] sm:w-64"
          />
        </div>

        <div className="mt-4 flex flex-col gap-2.5">
          {accounts === null && <EmptyNote>Loading accounts…</EmptyNote>}
          {accounts?.length === 0 && <EmptyNote>No accounts match that.</EmptyNote>}
          {accounts?.map((account) => (
            <AccountRow
              key={account.userId}
              account={account}
              busy={busy}
              onAct={act}
            />
          ))}
        </div>
      </Panel>
    </Shell>
  );
}

function AccountRow({
  account,
  busy,
  onAct,
}: {
  account: AdminAccount;
  busy: string | null;
  onAct: (userId: string, action: string, credits?: number) => void;
}) {
  const status = describeAccountStatus(account);
  const tone = STATUS_TONE[status.tone];
  const left = creditsLeft(account);
  const request = describeRequest(account.requestedPlan);

  return (
    <div
      className="rounded-xl border bg-[#0a141c] p-3.5"
      style={{ borderColor: tone.border }}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[14px] font-black tracking-[-0.02em]">{account.email}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]">
            {/* Words carry the state; the border colour only echoes them. */}
            <span className="font-black uppercase tracking-[0.1em]" style={{ color: tone.text }}>
              {status.planLabel} · {status.label}
            </span>
            {request && <span className="font-bold text-[#7f919c]">{request}</span>}
            <span className="text-[#5f7280]">
              Registered {formatWhen(account.registeredAt)}
            </span>
          </div>
        </div>

        <dl className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-[#8fa0aa]">
          <Stat label="AI drafts left" value={left === null ? 'Unlimited' : String(left)} />
          <Stat label="AI drafts used" value={String(account.aiDraftsUsed)} />
          <Stat label="AI calls" value={String(account.aiCalls)} />
          <Stat label="AI spend" value={formatSpend(account.aiSpendUsd)} />
          <Stat label="Drafts" value={String(account.draftCount)} />
          <Stat label="Last draft" value={formatWhen(account.lastDraftAt)} />
          <Stat label="Last activity" value={formatWhen(account.lastActivityAt)} />
        </dl>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {actionsFor(account).map((button) => {
          const key = `${account.userId}:${button.action}:${button.credits ?? ''}`;
          return (
            <button
              key={key}
              type="button"
              disabled={busy !== null}
              onClick={() => onAct(account.userId, button.action, button.credits)}
              className={`rounded-lg px-3 py-1.5 text-[11.5px] font-black transition disabled:opacity-40 ${
                button.primary
                  ? 'bg-[#b9ff38] text-[#08120a] hover:bg-[#c9ff5f]'
                  : button.action === 'disable'
                    ? 'border border-[#3d2020] text-[#ff9a80] hover:border-[#5a2f2f]'
                    : 'border border-[#22333e] text-[#c3d1d9] hover:border-[#3c5261]'
              }`}
            >
              {busy === key ? 'Working…' : button.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function AiPanel({
  ai,
  busy,
  onAct,
}: {
  ai: AiControls;
  busy: string | null;
  onAct: (action: string, payload?: Record<string, unknown>) => void;
}) {
  return (
    <Panel className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PanelTitle>AI Strategist controls</PanelTitle>
        <div className="flex items-center gap-2">
          <span
            className="text-[11px] font-black uppercase tracking-[0.12em]"
            style={{ color: ai.enabled ? '#b9ff38' : '#ff9a80' }}
          >
            {ai.enabled ? 'AI is ON' : 'AI is OFF'}
          </span>
          <button
            type="button"
            disabled={busy !== null || (ai.environmentKillSwitch && !ai.enabled)}
            onClick={() => onAct(ai.enabled ? 'ai_off' : 'ai_on')}
            className={`rounded-lg px-3 py-1.5 text-[11.5px] font-black transition disabled:opacity-40 ${
              ai.enabled
                ? 'border border-[#3d2020] text-[#ff9a80] hover:border-[#5a2f2f]'
                : 'bg-[#b9ff38] text-[#08120a] hover:bg-[#c9ff5f]'
            }`}
          >
            {ai.enabled ? 'Switch AI off' : 'Switch AI on'}
          </button>
        </div>
      </div>

      {ai.disabledReason && (
        <p className="mt-2 text-[12px] leading-5 text-[#e0a13c]">{ai.disabledReason}</p>
      )}
      {ai.environmentKillSwitch && (
        /* Worth saying out loud: this one needs a deploy to lift, so the
           button above cannot undo it and an operator should not be left
           clicking it. */
        <p className="mt-2 text-[12px] leading-5 text-[#ff9a80]">
          The deployment-level kill switch is set. AI stays off until it is
          removed from the server configuration - switching it on here will not
          override it.
        </p>
      )}

      <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Spent today" value={formatSpend(ai.spendTodayUsd)} big />
        <Stat label="Daily cap" value={formatSpend(ai.dailyCapUsd)} big />
        <Stat label="Spent this month" value={formatSpend(ai.spendMonthUsd)} big />
        <Stat label="Monthly cap" value={formatSpend(ai.monthlyCapUsd)} big />
        <Stat label="Per-draft cap" value={formatSpend(ai.perDraftCapUsd)} big />
        <Stat label="Requests in flight" value={String(ai.inFlight)} big />
      </dl>

      <p className="mt-3 text-[11.5px] leading-5 text-[#5f7280]">
        Every draft is also capped at {ai.maxCallsPerDraft} AI calls and{' '}
        {ai.maxRepairsPerDraft} retries. When any cap is reached the draft keeps
        working on Juancho and no AI request is made.
      </p>

      {ai.attempts && ai.attempts.length > 0 && (
        <div className="mt-4 border-t border-[#16242d] pt-3">
          <PanelTitle>Recent AI attempts</PanelTitle>
          <ul className="mt-2 flex flex-col gap-1">
            {ai.attempts.slice(0, 12).map((attempt, index) => (
              <li
                key={`${attempt.createdAt}-${index}`}
                className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11.5px] text-[#8fa0aa]"
              >
                <span className="font-mono text-[#5f7280]">
                  {attempt.sleeperDraftId.slice(0, 6)}…
                </span>
                <span className="font-bold text-[#c3d1d9]">
                  Pick {attempt.selectionKey ?? '?'}
                </span>
                {attempt.isRepair && <span className="text-[#e0a13c]">repair</span>}
                <span
                  className="font-black uppercase tracking-[0.08em]"
                  style={{ color: attempt.outcome === 'answered' ? '#b9ff38' : '#ff9a80' }}
                >
                  {attempt.outcome.replace(/_/g, ' ')}
                </span>
                {attempt.stopReason && <span>stop={attempt.stopReason}</span>}
                {attempt.hadToolUse && attempt.toolInputKeyCount === 0 && (
                  <span className="text-[#ff9a80]">empty tool input</span>
                )}
                {attempt.providerErrorType && (
                  <span className="text-[#ff9a80]">
                    {attempt.providerStatus} {attempt.providerErrorType}
                  </span>
                )}
                {attempt.validationFaults.length > 0 && (
                  <span>missing: {attempt.validationFaults.slice(0, 3).join(', ')}</span>
                )}
                <span className="text-[#5f7280]">{formatSpend(attempt.estimatedCostUsd)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}

function Stat({ label, value, big = false }: { label: string; value: string; big?: boolean }) {
  return (
    <div>
      <dt className="text-[10px] font-black uppercase tracking-[0.1em] text-[#5f7280]">{label}</dt>
      <dd className={`${big ? 'text-[15px]' : 'text-[12px]'} font-black text-[#e2e8eb]`}>{value}</dd>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-[#071019] text-[#f7f8f2]">
      <header className="border-b border-[#1c2b35] px-5 py-4">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4">
          <Brand />
          <Link
            href="/"
            className="text-[11px] font-bold text-[#5f7280] transition hover:text-[#b9ff38]"
          >
            Back to drafting
          </Link>
        </div>
      </header>
      <div className="mx-auto w-full max-w-6xl px-5 py-8">{children}</div>
    </main>
  );
}
