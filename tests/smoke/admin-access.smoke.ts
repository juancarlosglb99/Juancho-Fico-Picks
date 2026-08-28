/**
 * Who can reach the admin routes, against a real database.
 *
 * The rule these hold: authorisation comes from the session cookie and our own
 * `entitlement` rows, and from nowhere else. There is no header, body field or
 * query parameter a browser can set that changes the answer - so the tests that
 * matter most here are the ones that TRY, and get nothing.
 *
 * 404 rather than 403 throughout, on purpose. Whether an admin surface exists
 * is not something a customer needs confirmed.
 *
 *     DATABASE_URL=postgres://…/juancho_fico_dev npm run test:smoke
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePool, databaseConfigured, query } from '../../packages/db/client';
import { ensureAccount, setEntitlement } from '../../packages/accounts/repository';

const configured = databaseConfigured();
const suite = configured ? describe : describe.skip;

const ADMIN = { id: 'smoke-admin', name: 'Admin', email: 'smoke-admin@test' };
const CUSTOMER = { id: 'smoke-customer', name: 'Customer', email: 'smoke-customer@test' };
const VICTIM = { id: 'smoke-victim', name: 'Victim', email: 'smoke-victim@test' };

/** Who the auth layer says is calling. Swapped per test, never per request. */
let caller: { id: string; name: string; email: string } | null = null;

vi.mock('../../packages/auth/server', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../packages/auth/server')>();
  return { ...original, currentUser: async () => caller };
});

const users = await import('../../app/api/admin/users/route');
const ai = await import('../../app/api/admin/ai/route');

function request(body?: unknown) {
  return new Request('https://example.test/api/admin/users', {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function makeUser(user: { id: string; name: string; email: string }) {
  await query(
    `insert into "user" ("id","name","email","emailVerified","createdAt","updatedAt")
     values ($1,$2,$3,false,now(),now()) on conflict ("id") do nothing`,
    [user.id, user.name, user.email],
  );
  await ensureAccount({ userId: user.id, displayName: user.name });
}

async function planOf(userId: string): Promise<string> {
  const rows = await query<{ plan: string }>(
    `select plan from entitlement where user_id = $1 and status = 'active'`,
    [userId],
  );
  return rows[0]?.plan ?? 'none';
}

suite('who can reach the admin routes', () => {
  beforeAll(async () => {
    await query(`delete from "user" where id in ($1,$2,$3)`, [ADMIN.id, CUSTOMER.id, VICTIM.id]);
    for (const user of [ADMIN, CUSTOMER, VICTIM]) await makeUser(user);
    await setEntitlement({ userId: ADMIN.id, plan: 'admin' });
    await setEntitlement({ userId: CUSTOMER.id, plan: 'pro' });
  });

  afterAll(async () => {
    await query(`delete from "user" where id in ($1,$2,$3)`, [ADMIN.id, CUSTOMER.id, VICTIM.id]);
    await closePool();
  });

  beforeEach(() => {
    caller = null;
  });

  it('answers 404 to somebody who is not signed in', async () => {
    expect((await users.GET(request())).status).toBe(404);
    expect((await ai.GET(new Request('https://example.test/api/admin/ai'))).status).toBe(404);
  });

  it('answers 404 to a signed-in Pro customer', async () => {
    caller = CUSTOMER;
    expect((await users.GET(request())).status).toBe(404);
  });

  it('refuses a customer trying to make themselves an admin, and changes nothing', async () => {
    caller = CUSTOMER;
    const response = await users.POST(request({ userId: CUSTOMER.id, action: 'set_admin' }));
    expect(response.status).toBe(404);
    // The assertion that matters: the attempt had no effect.
    expect(await planOf(CUSTOMER.id)).toBe('pro');
  });

  it('refuses a customer granting themselves credits', async () => {
    caller = CUSTOMER;
    const response = await users.POST(
      request({ userId: CUSTOMER.id, action: 'add_credits', credits: 999 }),
    );
    expect(response.status).toBe(404);
    const rows = await query<{ included: number }>(
      `select included_credits as included from ai_draft_credits where user_id = $1`,
      [CUSTOMER.id],
    );
    expect(Number(rows[0].included)).toBe(0);
  });

  it('refuses a customer switching the deployment-wide AI controls', async () => {
    caller = CUSTOMER;
    const response = await ai.POST(
      new Request('https://example.test/api/admin/ai', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'ai_off', reason: 'not yours to switch' }),
      }),
    );
    expect(response.status).toBe(404);
  });

  it('lets a real admin through, and activating Pro grants the advertised drafts', async () => {
    caller = ADMIN;
    const response = await users.POST(request({ userId: VICTIM.id, action: 'activate_pro' }));
    expect(response.status).toBe(200);
    expect(await planOf(VICTIM.id)).toBe('pro');
    const rows = await query<{ included: number }>(
      `select included_credits as included from ai_draft_credits where user_id = $1`,
      [VICTIM.id],
    );
    // The bundle is one action, so an operator cannot forget half of it.
    expect(Number(rows[0].included)).toBe(3);
  });

  it('stops being an admin the moment the entitlement changes', async () => {
    caller = ADMIN;
    expect((await users.GET(request())).status).toBe(200);
    await setEntitlement({ userId: ADMIN.id, plan: 'pro' });
    // No cache, no token to expire: the next request reads the row again.
    expect((await users.GET(request())).status).toBe(404);
    await setEntitlement({ userId: ADMIN.id, plan: 'admin' });
  });

  it('refuses an id that is not an account, cleanly', async () => {
    /*
     * Found in production QA: a malformed user id reached Postgres as a
     * foreign key violation and came back as a 500 with a stack trace in the
     * log. An operator acting on a row that has since been deleted deserves a
     * sentence.
     */
    caller = ADMIN;
    const response = await users.POST(
      request({ userId: 'no-such-user-at-all', action: 'activate_basic' }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toMatch(/No such account/i);
  });

  it('never returns a secret', async () => {
    caller = ADMIN;
    const body = await (await ai.GET(new Request('https://example.test/api/admin/ai'))).text();
    for (const forbidden of ['ANTHROPIC', 'sk-ant', 'BETTER_AUTH_SECRET', 'DATABASE_URL', 'postgres://']) {
      expect(body, forbidden).not.toContain(forbidden);
    }
  });
});
