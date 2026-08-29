/**
 * Better Auth's own endpoints: sign up, sign in, sign out, verify, reset.
 *
 * Everything is delegated. The value of this file is the failure case: with no
 * database or no secret, it answers 503 with a reason instead of throwing at
 * import time and taking the whole application - including a draft room that
 * does not need accounts - down with it.
 */
import { toNextJsHandler } from 'better-auth/next-js';
import { authUnavailableReason, getAuth } from '../../../../packages/auth/server';

function unavailable(): Response {
  return Response.json(
    {
      error: 'Accounts are not configured on this server.',
      detail: authUnavailableReason(),
    },
    { status: 503 },
  );
}

export async function GET(request: Request): Promise<Response> {
  const auth = getAuth();
  if (!auth) return unavailable();
  return toNextJsHandler(auth).GET(request);
}

export async function POST(request: Request): Promise<Response> {
  const auth = getAuth();
  if (!auth) return unavailable();
  return toNextJsHandler(auth).POST(request);
}
