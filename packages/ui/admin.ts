/**
 * The operator's view of an account, decided away from the markup.
 *
 * The admin page exists so beta users are not managed over SSH. What makes it
 * safe to use quickly is that each row says the same three things in the same
 * order - what they asked for, what they have, and what it has cost - and that
 * the buttons offered are the ones that make sense for the row they are on.
 *
 * Pure, so the awkward states can be tested without a browser: an account that
 * asked for Pro and was given Basic, one whose access was revoked, one that has
 * spent credits it no longer has.
 *
 * NOTHING HERE AUTHORISES ANYTHING. Every action posts to a route that resolves
 * the caller from their session cookie and reads the entitlement table. What
 * this decides is which buttons to draw.
 */
import type { Plan } from '../accounts/entitlements';
import type { RequestedPlan } from './plans';

export interface AdminAccount {
  userId: string;
  email: string;
  name: string | null;
  registeredAt: string;
  requestedPlan: RequestedPlan | null;
  plan: Plan | null;
  entitlementStatus: 'active' | 'expired' | 'revoked' | null;
  creditsIncluded: number;
  creditsConsumed: number;
  aiDraftsUsed: number;
  aiCalls: number;
  aiSpendUsd: number;
  draftCount: number;
  lastDraftAt: string | null;
  lastActivityAt: string | null;
}

export type AccountStatusTone = 'waiting' | 'active' | 'stopped';

export interface AccountStatus {
  label: string;
  tone: AccountStatusTone;
  /** The tier, spelled out. Never a colour on its own. */
  planLabel: string;
}

/**
 * What state this account is in, in the words an operator thinks in.
 *
 * "Waiting" is the one that matters: it is the queue this page exists to clear,
 * and it is deliberately distinct from Basic. An account with no entitlement
 * has no product at all, which is not the same as having the cheaper one.
 */
export function describeAccountStatus(account: AdminAccount): AccountStatus {
  if (account.entitlementStatus === 'revoked' || (account.plan === null && account.entitlementStatus)) {
    return { label: 'Disabled', tone: 'stopped', planLabel: 'No access' };
  }
  if (!account.plan) {
    return { label: 'Waiting for activation', tone: 'waiting', planLabel: 'Not activated' };
  }
  const planLabel = account.plan === 'admin' ? 'Admin' : account.plan === 'pro' ? 'Pro' : 'Basic';
  return { label: 'Active', tone: 'active', planLabel };
}

/** Credits left, never negative, and null for a plan that does not meter. */
export function creditsLeft(account: AdminAccount): number | null {
  if (account.plan === 'admin') return null;
  return Math.max(0, account.creditsIncluded - account.creditsConsumed);
}

export type AdminAction =
  | 'activate_basic'
  | 'activate_pro'
  | 'set_basic'
  | 'set_pro'
  | 'set_admin'
  | 'add_credits'
  | 'disable';

export interface AdminActionButton {
  action: AdminAction;
  label: string;
  /** Only the credit actions carry one. */
  credits?: number;
  /** The one action the row is really waiting for, drawn first. */
  primary: boolean;
}

/**
 * Which buttons this row should offer.
 *
 * An account waiting for activation gets the two activate actions, with the
 * plan they ASKED for first - the commonest operation on this page is "give
 * this person what they requested", and it should be one obvious click.
 */
export function actionsFor(account: AdminAccount): AdminActionButton[] {
  const status = describeAccountStatus(account);

  if (status.tone !== 'active') {
    const wantsPro = account.requestedPlan === 'pro';
    const activatePro: AdminActionButton = {
      action: 'activate_pro',
      label: 'Activate Pro + 3 AI drafts',
      primary: wantsPro,
    };
    const activateBasic: AdminActionButton = {
      action: 'activate_basic',
      label: 'Activate Basic',
      primary: !wantsPro,
    };
    return wantsPro ? [activatePro, activateBasic] : [activateBasic, activatePro];
  }

  const buttons: AdminActionButton[] = [];
  if (account.plan !== 'pro') buttons.push({ action: 'set_pro', label: 'Set Pro', primary: false });
  if (account.plan !== 'basic') {
    buttons.push({ action: 'set_basic', label: 'Set Basic', primary: false });
  }
  if (account.plan !== 'admin') {
    buttons.push({ action: 'set_admin', label: 'Set Admin', primary: false });
  }
  if (account.plan !== 'admin') {
    buttons.push({ action: 'add_credits', label: '+1 draft', credits: 1, primary: false });
    buttons.push({ action: 'add_credits', label: '+3 drafts', credits: 3, primary: false });
  }
  buttons.push({ action: 'disable', label: 'Disable', primary: false });
  return buttons;
}

/* -------------------------------------------------------------- formatting */

/** Dollars, to the cent, because a bill is not a fantasy projection. */
export function formatSpend(usd: number): string {
  return `$${(Math.round(usd * 100) / 100).toFixed(2)}`;
}

/** "3 days ago", and the awkward ends of that scale. */
export function formatWhen(iso: string | null, now: Date = new Date()): string {
  if (!iso) return 'Never';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 'Unknown';
  const minutes = Math.floor((now.getTime() - then) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 31) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(then).toISOString().slice(0, 10);
}

/** "Requested: PRO", or nothing at all when they never chose. */
export function describeRequest(plan: RequestedPlan | null): string | null {
  if (!plan) return null;
  return `Requested: ${plan === 'pro' ? 'PRO' : 'BASIC'}`;
}
