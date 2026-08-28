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
 */
import pg from 'pg';

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const [command, email, value, until] = process.argv.slice(2);
if (!command || !email) {
  console.error(
    'Usage:\n' +
      '  npm run account -- show <email>\n' +
      '  npm run account -- plan <email> basic|pro|admin [validUntil]\n' +
      '  npm run account -- credits <email> <count>\n' +
      '  npm run account -- admin <email>',
  );
  process.exit(1);
}

const client = new pg.Client({
  connectionString: url,
  ssl: /@(localhost|127\.0\.0\.1)[:/]/.test(url) ? undefined : { rejectUnauthorized: true },
});

async function main() {
  await client.connect();
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

main()
  .then(() => client.end())
  .catch(async (error) => {
    await client.query('rollback').catch(() => {});
    console.error(`\n${error.message}`);
    await client.end().catch(() => {});
    process.exit(1);
  });
