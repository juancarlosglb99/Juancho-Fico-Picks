#!/usr/bin/env node
/**
 * `npm run account` - grant a plan or credits from a terminal.
 *
 * There is no billing yet, so this is how a Pro account comes into existence:
 * deliberately a server-side command rather than a screen, because until money
 * changes hands the only person who should be able to hand out entitlements is
 * whoever holds the database credentials.
 *
 *   npm run account -- show   juan@example.com
 *   npm run account -- plan   juan@example.com pro [2026-12-31]
 *   npm run account -- credits juan@example.com 5
 *   npm run account -- admin  juan@example.com
 *
 * And the deployment-wide AI controls, which take no email:
 *
 *   npm run account -- ai status
 *   npm run account -- ai off "runaway spend on 2026-08-28"
 *   npm run account -- ai on
 *   npm run account -- ai daily 10
 *   npm run account -- ai monthly 100
 *
 * `ai off` is the live kill switch: it stops every strategist request from
 * every account immediately, with no restart and no deploy. Drafts keep working
 * on the deterministic engine, which is the entire reason it is safe to reach
 * for. `AI_KILL_SWITCH=true` in the environment does the same thing and wins
 * over anything set here, so it cannot be undone with `ai on`.
 */
import pg from 'pg';
import { databaseTls } from '../packages/db/ssl.mjs';

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const [command, email, value, until] = process.argv.slice(2);
const USAGE =
  'Usage:\n' +
  '  npm run account -- show <email>\n' +
  '  npm run account -- plan <email> basic|pro|admin [validUntil]\n' +
  '  npm run account -- credits <email> <count>\n' +
  '  npm run account -- admin <email>\n' +
  '  npm run account -- ai status\n' +
  '  npm run account -- ai on|off [reason]\n' +
  '  npm run account -- ai daily|monthly <usd|none>';

// The AI controls are about the deployment, not a person, so they take no email.
const isAiCommand = command === 'ai';
if (!command || (!isAiCommand && !email)) {
  console.error(USAGE);
  process.exit(1);
}

// The same rule the pool, the migration script and the preflight use. This
// file had its own copy, which is how the very first `ai status` on the real
// Droplet failed with "The server does not support SSL connections" against a
// container the app itself was already talking to.
const client = new pg.Client({ connectionString: url, ssl: databaseTls(url).ssl });

async function main() {
  await client.connect();
  if (isAiCommand) return aiControl();
  const found = await client.query('select id, email from "user" where email = $1', [email]);
  if (found.rowCount === 0) throw new Error(`No account for ${email}.`);
  const userId = found.rows[0].id;

  // Make sure the rows a first sign-in would have created exist.
  await client.query(
    `insert into user_profile (user_id) values ($1) on conflict do nothing`,
    [userId],
  );
  await client.query(
    `insert into ai_draft_credits (user_id) values ($1) on conflict do nothing`,
    [userId],
  );

  if (command === 'plan' || command === 'admin') {
    const plan = command === 'admin' ? 'admin' : value;
    if (!['basic', 'pro', 'admin'].includes(plan)) {
      throw new Error(`Unknown plan "${plan}". Use basic, pro or admin.`);
    }
    await client.query('begin');
    await client.query(
      `update entitlement set status = 'revoked', updated_at = now()
        where user_id = $1 and status = 'active'`,
      [userId],
    );
    await client.query(
      `insert into entitlement (user_id, plan, status, valid_until, note)
       values ($1, $2, 'active', $3, 'granted from the command line')`,
      [userId, plan, until ?? null],
    );
    await client.query('commit');
    console.log(`${email} is now on ${plan}${until ? ` until ${until}` : ''}.`);
  } else if (command === 'credits') {
    const count = Number(value);
    if (!Number.isFinite(count)) throw new Error('Give a number of credits.');
    await client.query(
      `update ai_draft_credits
          set included_credits = included_credits + $2, updated_at = now()
        where user_id = $1`,
      [userId, count],
    );
    console.log(`Added ${count} AI draft credit${count === 1 ? '' : 's'} to ${email}.`);
  } else if (command !== 'show') {
    throw new Error(`Unknown command "${command}".`);
  }

  const summary = await client.query(
    `select coalesce(e.plan, 'basic') as plan,
            e.valid_until,
            c.included_credits,
            c.consumed_credits,
            (select count(*) from draft_session s where s.user_id = u.id) as drafts,
            (select coalesce(sum(a.estimated_cost_usd), 0) from ai_usage a where a.user_id = u.id) as spent
       from "user" u
       left join entitlement e on e.user_id = u.id and e.status = 'active'
       left join ai_draft_credits c on c.user_id = u.id
      where u.id = $1`,
    [userId],
  );
  const row = summary.rows[0];
  console.log(
    `\n${email}\n` +
      `  plan     ${row.plan}${row.valid_until ? ` (until ${row.valid_until.toISOString().slice(0, 10)})` : ''}\n` +
      `  credits  ${row.included_credits - row.consumed_credits} of ${row.included_credits} left\n` +
      `  drafts   ${row.drafts}\n` +
      `  ai spend $${Number(row.spent).toFixed(3)}`,
  );
}

/**
 * The deployment-wide AI switch and spend ceilings.
 *
 * One row, edited in place. The application reads it on every request and does
 * not cache it, so a change here is in force for the next call anybody makes -
 * including a draft that is already running.
 */
async function aiControl() {
  const sub = process.argv[3] ?? 'status';
  const rest = process.argv.slice(4).join(' ').trim();

  await client.query('insert into ai_control (id) values (true) on conflict (id) do nothing');

  if (sub === 'off') {
    await client.query(
      `update ai_control set enabled = false, disabled_reason = $1, updated_at = now() where id = true`,
      [rest || 'switched off from the command line'],
    );
  } else if (sub === 'on') {
    await client.query(
      `update ai_control set enabled = true, disabled_reason = null, updated_at = now() where id = true`,
    );
  } else if (sub === 'daily' || sub === 'monthly') {
    const column = sub === 'daily' ? 'daily_spend_limit_usd' : 'monthly_spend_limit_usd';
    // "none" clears the row's opinion; the environment default then applies.
    const limit = rest === '' || rest === 'none' ? null : Number(rest);
    if (limit !== null && (!Number.isFinite(limit) || limit < 0)) {
      throw new Error(`"${rest}" is not a spend limit. Give a number of dollars, or "none".`);
    }
    await client.query(
      `update ai_control set ${column} = $1, updated_at = now() where id = true`,
      [limit],
    );
  } else if (sub !== 'status') {
    throw new Error(`Unknown ai command "${sub}". Use status, on, off, daily or monthly.`);
  }

  const row = (await client.query(`select * from ai_control where id = true`)).rows[0];
  const spend = (
    await client.query(`
      select
        coalesce(sum(estimated_cost_usd)
          filter (where created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'),
          0) as today,
        coalesce(sum(estimated_cost_usd), 0) as month,
        count(*) filter (where created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc')
          as calls_today
      from ai_usage
      where created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'`)
  ).rows[0];
  const live = (
    await client.query(
      `select count(*) as n from ai_request_lease where released_at is null and expires_at > now()`,
    )
  ).rows[0];

  const envSwitch = process.env.AI_KILL_SWITCH?.trim().toLowerCase() === 'true';
  console.log(
    `\nAI strategist\n` +
      `  switch     ${row.enabled ? 'on' : 'off'}${row.disabled_reason ? ` - ${row.disabled_reason}` : ''}` +
      `${envSwitch ? '\n  environment AI_KILL_SWITCH=true (overrides the row; "ai on" will not undo it)' : ''}\n` +
      `  daily cap  ${row.daily_spend_limit_usd === null ? 'from the environment' : `${Number(row.daily_spend_limit_usd).toFixed(2)}`}\n` +
      `  month cap  ${row.monthly_spend_limit_usd === null ? 'from the environment' : `${Number(row.monthly_spend_limit_usd).toFixed(2)}`}\n` +
      `  spent today ${Number(spend.today).toFixed(3)} over ${spend.calls_today} call${Number(spend.calls_today) === 1 ? '' : 's'}\n` +
      `  this month  ${Number(spend.month).toFixed(3)}\n` +
      `  in flight   ${live.n}`,
  );
}

main()
  .then(() => client.end())
  .catch(async (error) => {
    await client.query('rollback').catch(() => {});
    console.error(`\n${error.message}`);
    await client.end().catch(() => {});
    process.exit(1);
  });
