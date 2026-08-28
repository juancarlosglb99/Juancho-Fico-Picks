'use client';

/**
 * Who the server says we are, and what we are entitled to.
 *
 * Read from `/api/account` rather than from the session cookie, because the
 * plan and the credit balance live in the database and the cookie says nothing
 * about either. Refetched on demand after anything that could change them.
 *
 * Nothing here is authorisation. Every request that spends money asks the
 * server again.
 */
import { useCallback, useEffect, useState } from 'react';
import type { AccessState, Plan } from '@/packages/accounts/entitlements';

export interface AccountState {
  loading: boolean;
  /** False when the deployment has no database, which is a working mode. */
  accountsEnabled: boolean;
  signedIn: boolean;
  user: { id: string; email: string; name: string | null; emailVerified: boolean } | null;
  plan: Plan;
  /** Whether an admin has activated this account. The private beta's gate. */
  access: AccessState;
  creditsRemaining: number | null;
  /** Fatal server configuration problems. Empty in any healthy deployment. */
  misconfigured: string[];
  refresh: () => void;
}

const INITIAL = {
  accountsEnabled: false,
  signedIn: false,
  user: null,
  plan: 'basic' as Plan,
  access: 'pending' as AccessState,
  creditsRemaining: null as number | null,
  misconfigured: [] as string[],
};

export function useAccount(): AccountState {
  const [state, setState] = useState(INITIAL);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/account', { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (cancelled) return;
        if (body) setState({ ...INITIAL, ...(body as typeof INITIAL) });
        setLoading(false);
      })
      .catch(() => {
        // A failed lookup must not lock anybody out of a draft room that does
        // not need an account. It only means no AI.
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  return {
    ...state,
    loading,
    refresh: useCallback(() => setNonce((current) => current + 1), []),
  };
}
