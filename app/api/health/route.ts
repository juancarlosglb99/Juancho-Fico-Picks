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
import { schemaStatus } from '../../../packages/db/migrate';
import { authConfigured, authUnavailableReason } from '../../../packages/auth/server';
import { inspectRuntime } from '../../../packages/config/runtime';
import { effectiveLimits, killSwitchEngaged } from '../../../packages/accounts/ai-limits';

/**
 * What a load balancer asks, and what an operator needs when it says no.
 *
 * In PRODUCTION this is strict, because the alternative to failing is worse
 * than failing: an instance with no database would serve a perfectly
 * functional-looking application with no accounts and no authorisation. So a
 * production instance is unhealthy unless it is configured, the database
 * answers, and the schema is current - and App Platform will refuse to promote
 * a deploy whose health check never passes.
 *
 * In development it is generous. A draft room needs neither the database nor
 * the strategist, and saying so is more useful than a red light.
 */
export async function GET(): Promise<Response> {
  const runtime = inspectRuntime();
  const configured = databaseConfigured();
  const reachable = configured ? await databaseReachable() : false;
  const schema = reachable ? await schemaStatus() : configured ? 'unreachable' : 'unknown';

  const healthy = runtime.production
    ? runtime.problems.length === 0 && reachable && schema === 'current'
    : true;

  return Response.json(
    {
      status: healthy ? 'ok' : 'degraded',
      uptimeSeconds: Math.round(process.uptime()),
      environment: runtime.production ? 'production' : 'development',
      // Names and presence only. No value is ever read out of here.
      configuration: {
        present: runtime.present,
        problems: runtime.problems,
        warnings: runtime.warnings,
      },
      database: { configured, reachable, schema },
      auth: { configured: authConfigured(), reason: authUnavailableReason() },
      /*
       * The ceilings as the ENVIRONMENT sets them. The `ai_control` row can
       * lower them further and can switch AI off entirely, and it is not read
       * here on purpose: a health check that needed the database to report the
       * spend caps would go quiet at exactly the moment an operator wanted to
       * know what they were.
       */
      strategist: {
        configured: Boolean(process.env.ANTHROPIC_API_KEY),
        killSwitch: killSwitchEngaged(),
        limits: effectiveLimits(),
      },
    },
    { status: healthy ? 200 : 503 },
  );
}
