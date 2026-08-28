'use client';

/**
 * Whether the AI Strategist is switched on for the draft currently open.
 *
 * A credit buys a DRAFT, so this is the state that decides whether one gets
 * spent - and it starts as "no" for everybody. Opening a draft, watching one,
 * or running a casual mock never costs a Pro customer anything.
 *
 * Nothing here is authorisation. The server refuses any request for a draft
 * whose `ai_requested` flag is false, and it is the server that charges the
 * credit, on the first request it actually allows. What this hook holds is the
 * screen's copy of that answer, plus one local convenience: remembering that
 * somebody said "Standard Mode" so they are not asked again on every refresh.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Plan } from '@/packages/accounts/entitlements';

export interface DraftAiState {
  /** The strategist will be asked on this draft. Mirrors the server's flag. */
  enabled: boolean;
  /** This draft has already been charged. Re-enabling costs nothing. */
  creditConsumed: boolean;
  /** True until the drafter has answered the question for this draft. */
  needsChoice: boolean;
  busy: boolean;
  error: string | null;
  choose: (enabled: boolean) => void;
}

/** Where a decline is remembered, per draft, per browser. */
const declineKey = (draftId: string) => `jfp.ai-declined.${draftId}`;

function readDecline(draftId: string): boolean {
  try {
    return window.localStorage.getItem(declineKey(draftId)) === '1';
  } catch {
    // A private window, or storage switched off. Asking again is the safe
    // failure: it costs a click, never a credit.
    return false;
  }
}

function writeDecline(draftId: string, declined: boolean): void {
  try {
    if (declined) window.localStorage.setItem(declineKey(draftId), '1');
    else window.localStorage.removeItem(declineKey(draftId));
  } catch {
    /* Storage is a convenience here; losing it only means asking again. */
  }
}

export function useDraftAi({
  sleeperDraftId,
  leagueId,
  isMock,
  plan,
  accountsEnabled,
  onCreditsChanged,
}: {
  sleeperDraftId: string | null;
  leagueId: string | null;
  isMock: boolean;
  plan: Plan;
  accountsEnabled: boolean;
  /** Called after a change, so the balance on screen refreshes. */
  onCreditsChanged: () => void;
}): DraftAiState {
  /*
   * One object, stamped with the draft it describes.
   *
   * Keyed rather than reset, because resetting means setting state from an
   * effect on every draft change - and a stale `enabled: true` surviving for
   * one render into a different draft would show "AI draft" on a draft nobody
   * has paid for.
   */
  const [snapshot, setSnapshot] = useState<{
    draftId: string | null;
    enabled: boolean;
    creditConsumed: boolean;
    declined: boolean;
  }>({ draftId: null, enabled: false, creditConsumed: false, declined: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* Admin is always on and never asked: there is no credit to spend. */
  const isAdmin = plan === 'admin';

  /*
   * Read once per draft. A decline made during this session is carried by
   * `snapshot.declined` instead, so there is nothing to re-read for.
   */
  const declinedLocally = useMemo(
    () => (sleeperDraftId ? readDecline(sleeperDraftId) : false),
    [sleeperDraftId],
  );

  /* Anything not stamped with THIS draft is treated as unknown, which is off. */
  const current =
    snapshot.draftId === sleeperDraftId
      ? snapshot
      : { draftId: sleeperDraftId, enabled: false, creditConsumed: false, declined: false };

  useEffect(() => {
    if (!sleeperDraftId || !accountsEnabled || plan === 'basic') return;
    /*
     * Ask the server what it already knows, so re-entering a draft that was
     * switched on comes back switched on - and, more importantly, already paid
     * for. `enabled: isAdmin` is the current value rather than a change: for a
     * Pro drafter this writes false, which is already the default and never
     * clears a credit that has been spent.
     */
    let cancelled = false;
    void fetch('/api/draft/ai', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ sleeperDraftId, leagueId, isMock, enabled: isAdmin }),
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { aiRequested?: boolean; creditConsumed?: boolean } | null) => {
        if (cancelled || !body) return;
        setSnapshot({
          draftId: sleeperDraftId,
          enabled: Boolean(body.aiRequested),
          creditConsumed: Boolean(body.creditConsumed),
          declined: readDecline(sleeperDraftId),
        });
      })
      .catch(() => {
        /* A failed read leaves the draft in Standard Mode, which is safe. */
      });
    return () => {
      cancelled = true;
    };
  }, [sleeperDraftId, leagueId, isMock, plan, accountsEnabled, isAdmin]);

  const choose = useCallback(
    (next: boolean) => {
      if (!sleeperDraftId) return;
      if (!next) {
        // Declining is local and free. Nothing is written server-side, because
        // "off" is already the server's default for this draft.
        writeDecline(sleeperDraftId, true);
        setSnapshot((previous) => ({
          draftId: sleeperDraftId,
          enabled: false,
          creditConsumed: previous.draftId === sleeperDraftId ? previous.creditConsumed : false,
          declined: true,
        }));
        return;
      }
      setBusy(true);
      setError(null);
      void fetch('/api/draft/ai', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ sleeperDraftId, leagueId, isMock, enabled: true }),
      })
        .then((response) => response.json())
        .then(
          (body: {
            ok?: boolean;
            aiRequested?: boolean;
            creditConsumed?: boolean;
            error?: string;
          }) => {
            if (!body?.ok) {
              setError(body?.error ?? 'That did not work. Your draft is unaffected.');
              return;
            }
            writeDecline(sleeperDraftId, false);
            setSnapshot({
              draftId: sleeperDraftId,
              enabled: Boolean(body.aiRequested),
              creditConsumed: Boolean(body.creditConsumed),
              declined: false,
            });
            onCreditsChanged();
          },
        )
        .catch(() => setError('That did not work. Your draft is unaffected.'))
        .finally(() => setBusy(false));
    },
    [sleeperDraftId, leagueId, isMock, onCreditsChanged],
  );

  const declined = current.declined || declinedLocally;

  return {
    enabled: isAdmin || current.enabled,
    creditConsumed: current.creditConsumed,
    // Only Pro is ever asked. Basic has nothing to choose, admin has no cost.
    needsChoice:
      accountsEnabled && plan === 'pro' && !current.enabled && !declined && sleeperDraftId !== null,
    busy,
    error,
    choose,
  };
}
