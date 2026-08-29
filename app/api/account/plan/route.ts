/**
 * "I want Pro." Recorded, and nothing more.
 *
 * The single most important thing about this endpoint is what it does not do:
 * it does not grant access, it does not create an entitlement, and it does not
 * touch a credit balance. It writes one column on the caller's own profile so
 * that the pending screen can say what they chose and an admin can see who is
 * waiting for what.
 *
 * The caller is taken from the session cookie. There is no field in the body
 * that names a user, so this cannot be pointed at somebody else's account.
 */
import { requestPlan } from '../../../../packages/accounts/service';

export async function POST(request: Request): Promise<Response> {
  let body: { plan?: unknown };
  try {
    body = (await request.json()) as { plan?: unknown };
  } catch {
    return Response.json({ error: 'Malformed request body.' }, { status: 400 });
  }

  const result = await requestPlan(request, body?.plan);
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.error === 'Sign in first.' ? 401 : 400 });
  }
  return Response.json({ requestedPlan: result.requestedPlan });
}
