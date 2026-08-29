/**
 * Who the browser is, according to the server.
 *
 * The plan and the credit balance are read here and nowhere else. A client that
 * edits its own copy changes what it draws and nothing about what it is allowed
 * to do - every decision that spends money is made again on the server, from
 * the database, on every request.
 */
import { accountSummary } from '../../../packages/accounts/service';

export async function GET(request: Request): Promise<Response> {
  try {
    return Response.json(await accountSummary(request));
  } catch (error) {
    return Response.json(
      {
        signedIn: false,
        user: null,
        plan: 'basic',
        creditsRemaining: null,
        accountsEnabled: false,
        error: error instanceof Error ? error.message : 'Account lookup failed.',
      },
      { status: 200 },
    );
  }
}
