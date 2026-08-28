/**
 * The global AI controls, as a page rather than an SSH session.
 *
 * This is a VIEW OVER THE EXISTING CONTROLS, not a second set of them. It reads
 * and writes the same `ai_control` row the CLI writes and `resolveAiAccess`
 * consults on every request, and it reports the same effective limits the
 * health endpoint does. A second, independent switch would eventually disagree
 * with the first, and the way an operator would find out is a bill.
 *
 * Nothing secret is returned. Spend, caps, the switch and the in-flight count -
 * no keys, no connection strings, no environment.
 */
import {
  globalSpend,
  readAiControl,
  setAiControl,
} from '../../../../packages/accounts/repository';
import { requireAdmin } from '../../../../packages/accounts/service';
import { effectiveLimits, killSwitchEngaged } from '../../../../packages/accounts/ai-limits';
import { query } from '../../../../packages/db/client';

const NOT_FOUND = () => Response.json({ error: 'Not found.' }, { status: 404 });

async function snapshot() {
  const control = await readAiControl();
  const spend = await globalSpend();
  const limits = effectiveLimits(process.env, control);
  const inFlight = await query<{ n: string }>(
    `select count(*) as n from ai_request_lease
      where released_at is null and expires_at > now()`,
  );
  const envSwitch = killSwitchEngaged();
  return {
    // Off if EITHER says off, which is the same rule the request path applies.
    enabled: control.enabled && !envSwitch,
    disabledReason: control.disabledReason,
    /*
     * Surfaced separately because it changes what the buttons can do: the
     * environment switch needs a deploy to lift, so "turn AI on" here cannot
     * undo it, and an operator should be told that rather than left clicking.
     */
    environmentKillSwitch: envSwitch,
    spendTodayUsd: spend.todayUsd,
    spendMonthUsd: spend.monthUsd,
    dailyCapUsd: limits.dailySpendLimitUsd,
    monthlyCapUsd: limits.monthlySpendLimitUsd,
    perDraftCapUsd: limits.maxDraftSpendUsd,
    maxCallsPerDraft: limits.maxPrimaryCallsPerDraft,
    maxRepairsPerDraft: limits.maxRepairCallsPerDraft,
    inFlight: Number(inFlight[0]?.n ?? 0),
  };
}

export async function GET(request: Request): Promise<Response> {
  if (!(await requireAdmin(request))) return NOT_FOUND();
  return Response.json(await snapshot());
}

interface Body {
  action?: string;
  reason?: string;
  usd?: number | null;
}

export async function POST(request: Request): Promise<Response> {
  const admin = await requireAdmin(request);
  if (!admin) return NOT_FOUND();

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json({ error: 'Malformed request body.' }, { status: 400 });
  }

  const limit = (value: unknown): number | null => {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error('Give a number of dollars, or clear it.');
    return parsed;
  };

  try {
    switch (body.action) {
      case 'ai_off':
        await setAiControl({
          enabled: false,
          disabledReason: (body.reason || '').trim() || `switched off by ${admin.email}`,
        });
        break;
      case 'ai_on':
        await setAiControl({ enabled: true });
        break;
      case 'daily_cap':
        await setAiControl({ dailySpendLimitUsd: limit(body.usd) });
        break;
      case 'monthly_cap':
        await setAiControl({ monthlySpendLimitUsd: limit(body.usd) });
        break;
      default:
        return Response.json({ error: `Unknown action "${body.action}".` }, { status: 400 });
    }
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'That did not work.' },
      { status: 400 },
    );
  }

  return Response.json({ ok: true, ...(await snapshot()) });
}
