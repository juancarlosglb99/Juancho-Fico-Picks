/**
 * The admin user list, and the handful of actions an operator performs on it.
 *
 * EVERY REQUEST IS AUTHORISED HERE, from the session cookie and our own rows.
 * There is no `admin=true` to send, no plan in the body, no header that changes
 * the answer - `requireAdmin` resolves the caller from the cookie and reads the
 * entitlement table, so an admin whose access is revoked stops being one on
 * their next request. A non-admin gets 404 rather than 403: the existence of
 * this route is not something a customer needs confirmed.
 *
 * The actions are the same ones `scripts/account.mjs` performs, through the
 * same repository functions. That is on purpose - the CLI stays as the
 * emergency fallback, and two implementations of "activate this account" would
 * eventually disagree about what activation means.
 */
import {
  grantCredits,
  listAdminUsers,
  revokeEntitlement,
  setCredits,
  setEntitlement,
} from '../../../../packages/accounts/repository';
import { requireAdmin } from '../../../../packages/accounts/service';
import { query } from '../../../../packages/db/client';
import { PRO_OFFER } from '../../../../packages/ui/plans';

const NOT_FOUND = () => Response.json({ error: 'Not found.' }, { status: 404 });

export async function GET(request: Request): Promise<Response> {
  if (!(await requireAdmin(request))) return NOT_FOUND();
  const url = new URL(request.url);
  const users = await listAdminUsers({ search: url.searchParams.get('q') });
  return Response.json({ users });
}

interface ActionBody {
  userId?: string;
  action?: string;
  /** Only read by the credit actions. */
  credits?: number;
}

export async function POST(request: Request): Promise<Response> {
  const admin = await requireAdmin(request);
  if (!admin) return NOT_FOUND();

  let body: ActionBody;
  try {
    body = (await request.json()) as ActionBody;
  } catch {
    return Response.json({ error: 'Malformed request body.' }, { status: 400 });
  }

  const userId = typeof body?.userId === 'string' ? body.userId : '';
  if (!userId) return Response.json({ error: 'A user is required.' }, { status: 400 });

  const note = `set by ${admin.email} from the admin page`;

  /*
   * A user id that does not exist reaches Postgres as a foreign key violation,
   * which without this became a 500 and a stack trace in the log. Production
   * QA found it by sending a malformed id. An operator acting on a row that
   * has since been deleted deserves a sentence, not an outage.
   */
  const exists = await query<{ id: string }>(`select id from "user" where id = $1`, [userId]);
  if (exists.length === 0) {
    return Response.json({ error: 'No such account. Reload the list.' }, { status: 400 });
  }

  try {
    return await applyAction(body, userId, note);
  } catch (error) {
    // Anything the database refuses is reported as a refusal, not as a crash.
    return Response.json(
      {
        error: 'That action was not applied.',
        detail: error instanceof Error ? error.message : undefined,
      },
      { status: 400 },
    );
  }
}

async function applyAction(body: ActionBody, userId: string, note: string): Promise<Response> {
  switch (body.action) {
    case 'activate_basic':
      await setEntitlement({ userId, plan: 'basic', note });
      break;

    case 'activate_pro':
      /*
       * The advertised bundle, in one action. Pro includes three AI drafts, and
       * an operator who had to remember to grant them separately would
       * eventually not - which is a customer who paid for three and got none.
       */
      await setEntitlement({ userId, plan: 'pro', note });
      await grantCredits({ userId, credits: PRO_OFFER.includedAiDrafts });
      break;

    case 'set_basic':
      await setEntitlement({ userId, plan: 'basic', note });
      break;
    case 'set_pro':
      await setEntitlement({ userId, plan: 'pro', note });
      break;
    case 'set_admin':
      await setEntitlement({ userId, plan: 'admin', note });
      break;

    case 'add_credits': {
      const credits = Number(body.credits);
      if (!Number.isFinite(credits) || credits === 0) {
        return Response.json({ error: 'Give a number of credits.' }, { status: 400 });
      }
      await grantCredits({ userId, credits: Math.trunc(credits) });
      break;
    }

    case 'set_credits': {
      const credits = Number(body.credits);
      if (!Number.isFinite(credits) || credits < 0) {
        return Response.json({ error: 'Give a number of credits.' }, { status: 400 });
      }
      await setCredits({ userId, included: Math.trunc(credits) });
      break;
    }

    case 'disable':
      // Revoked, not deleted. The account and its history stay; access stops.
      await revokeEntitlement(userId);
      break;

    default:
      return Response.json({ error: `Unknown action "${body.action}".` }, { status: 400 });
  }

  const users = await listAdminUsers({ search: null });
  return Response.json({ ok: true, users });
}
