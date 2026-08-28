/**
 * What a load balancer asks, and what an operator needs when it says no.
 *
 * Deliberately generous about what counts as healthy. The container is serving
 * correctly if it can render a draft room, and a draft room needs neither the
 * database nor the strategist - so a missing key or an unreachable Postgres is
 * REPORTED rather than failing the check. What fails the check is a database
 * that is configured, reachable, and missing its schema, because that is the
 * state in which sign-in silently breaks.
 */
import { databaseConfigured, databaseReachable } from '../../../packages/db/client';
import { schemaUpToDate } from '../../../packages/db/migrate';
import { authConfigured, authUnavailableReason } from '../../../packages/auth/server';

export async function GET(): Promise<Response> {
  const database = databaseConfigured();
  const reachable = database ? await databaseReachable() : false;
  const schema = reachable ? await schemaUpToDate() : false;

  const healthy = !database || !reachable || schema;

  return Response.json(
    {
      status: healthy ? 'ok' : 'degraded',
      uptimeSeconds: Math.round(process.uptime()),
      database: {
        configured: database,
        reachable,
        schemaUpToDate: schema,
      },
      auth: {
        configured: authConfigured(),
        reason: authUnavailableReason(),
      },
      strategist: {
        // Presence only. The key itself never appears in any response.
        configured: Boolean(process.env.ANTHROPIC_API_KEY),
      },
    },
    { status: healthy ? 200 : 503 },
  );
}
