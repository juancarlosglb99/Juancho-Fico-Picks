'use client';

/**
 * Registered, and waiting for somebody to say yes.
 *
 * The private beta's access control is a person rather than a payment: creating
 * an account gets you an account, and an admin activates it. This is the screen
 * in between, and it has to convey three things or it is worse than useless -
 * what you selected, what that includes, and that a human is the next step. A
 * sign-in that appears to work and then shows an empty product is the failure
 * this replaces.
 *
 * An account that arrived here without choosing a plan is shown the choice
 * rather than a dead end. Choosing still grants nothing.
 */
import { useState } from 'react';
import { pendingSummary, type RequestedPlan } from '@/packages/ui/plans';
import { PlanCards, PlanCardsIntro } from './plan-cards';
import { Brand, ErrorBanner, Panel } from './primitives';

export function PendingScreen({
  email,
  revoked,
  requestedPlan,
  onSignOut,
  onPlanChosen,
}: {
  email: string | null;
  /** Access taken away deliberately reads differently from never granted. */
  revoked: boolean;
  requestedPlan: RequestedPlan | null;
  onSignOut: () => void;
  onPlanChosen: () => void;
}) {
  const [busy, setBusy] = useState<RequestedPlan | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const summary = pendingSummary({ requestedPlan, revoked });
  const needsChoice = !revoked && requestedPlan === null;

  const choose = async (plan: RequestedPlan) => {
    setBusy(plan);
    setFailure(null);
    try {
      const response = await fetch('/api/account/plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ plan }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setFailure(body?.error ?? 'That did not save. Try again in a moment.');
        return;
      }
      onPlanChosen();
    } catch {
      setFailure('That did not save. Try again in a moment.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="min-h-screen bg-[#071019] text-[#f7f8f2]">
      <header className="border-b border-[#1c2b35] px-5 py-4">
        <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-4">
          <Brand />
          <button
            onClick={onSignOut}
            className="text-[11px] font-bold text-[#5f7280] transition hover:text-[#ff9a80]"
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="mx-auto w-full max-w-4xl px-5 py-12">
        {failure && (
          <div className="mb-4">
            <ErrorBanner message={failure} />
          </div>
        )}

        <Panel className="p-6">
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-[#e0a13c]">
            {summary.status}
          </p>
          <h1 className="mt-3 text-2xl font-black tracking-[-0.03em]">{summary.headline}</h1>

          {summary.selection && (
            <div className="mt-5 rounded-xl border border-[#2a3b46] bg-[#0d1922] px-4 py-3.5">
              <p className="text-[15px] font-black tracking-[-0.02em]">{summary.selection}</p>
              {summary.includes && (
                <p className="mt-1 text-[13px] leading-6 text-[#a3b1ba]">{summary.includes}</p>
              )}
              <p className="mt-2.5 text-[11px] font-black uppercase tracking-[0.12em] text-[#e0a13c]">
                Status: {summary.status}
              </p>
            </div>
          )}

          <p className="mt-4 max-w-2xl text-[14px] leading-7 text-[#a3b1ba]">{summary.body}</p>
          {email && (
            <p className="mt-4 text-[12px] font-bold text-[#5f7280]">Signed in as {email}</p>
          )}
        </Panel>

        {needsChoice && (
          <div className="mt-8">
            <PlanCardsIntro signedIn />
            <PlanCards onChoose={choose} busy={busy} selected={requestedPlan} />
          </div>
        )}

        {!needsChoice && !revoked && (
          <p className="mt-6 text-[13px] leading-6 text-[#7f919c]">
            Changed your mind?{' '}
            <button
              type="button"
              onClick={() => choose(requestedPlan === 'pro' ? 'basic' : 'pro')}
              className="font-bold text-[#b9ff38] underline-offset-2 hover:underline"
              disabled={busy !== null}
            >
              Switch to {requestedPlan === 'pro' ? 'Basic' : 'Pro'}
            </button>
          </p>
        )}
      </div>
    </main>
  );
}
