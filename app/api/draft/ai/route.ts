/**
 * Switching the AI Strategist on for one draft - the moment a credit is
 * committed to, and deliberately not the moment it is spent.
 *
 * A credit buys a DRAFT, so opening one, watching one, or running a casual mock
 * has to cost nothing. This is where a Pro drafter says "yes, use one on this
 * draft". The charge still happens server-side in `resolveAiAccess`, on the
 * first request it actually authorises, so:
 *
 *   - switching AI on and closing the tab spends nothing
 *   - switching it on for a draft your plan does not cover is refused, free
 *   - reopening a draft already paid for costs nothing more
 *
 * Nothing about the caller comes from the body. The session cookie identifies
 * the user and the draft session is looked up BY that user id, so naming
 * somebody else's draft creates an empty one of your own rather than touching
 * theirs.
 */
import { readDraftAi, setDraftAi } from '../../../../packages/accounts/service';

/**
 * What is already true about this draft, without changing any of it.
 *
 * A GET, because the screen asks this on entry and a read that writes turned
 * "reopen the draft you switched AI on for" into "switched back to Standard
 * Mode and asked again".
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const sleeperDraftId = url.searchParams.get('draftId') ?? '';
  if (!sleeperDraftId) {
    return Response.json({ error: 'A draft is required.' }, { status: 400 });
  }
  return Response.json(
    await readDraftAi(request, {
      sleeperDraftId,
      leagueId: url.searchParams.get('leagueId'),
      isMock: url.searchParams.get('isMock') === 'true',
    }),
  );
}

interface Body {
  sleeperDraftId?: string;
  leagueId?: string | null;
  isMock?: boolean;
  enabled?: boolean;
}

export async function POST(request: Request): Promise<Response> {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json({ error: 'Malformed request body.' }, { status: 400 });
  }

  if (typeof body?.sleeperDraftId !== 'string' || !body.sleeperDraftId) {
    return Response.json({ error: 'A draft is required.' }, { status: 400 });
  }

  const state = await setDraftAi(request, {
    sleeperDraftId: body.sleeperDraftId,
    leagueId: body.leagueId ?? null,
    isMock: Boolean(body.isMock),
    enabled: Boolean(body.enabled),
  });

  /*
   * 200 even on a refusal. The client's failure path is "stay in Standard
   * Mode", which is a working product - an HTTP error would make a normal plan
   * boundary look like a broken request.
   */
  return Response.json(state);
}
