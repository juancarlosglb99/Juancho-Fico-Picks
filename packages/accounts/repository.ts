/**
 * Reading and writing the account model.
 *
 * Thin on purpose: every decision lives in `entitlements.ts` as a pure function,
 * and this only fetches the rows those functions need and records what was
 * decided. There is no business rule in here that is not also a database
 * constraint.
 *
 * The one place that is genuinely subtle is spending a credit. Two requests for
 * the same draft can arrive at once, and both must not be able to charge for it.
 * `consumeDraftCredit` therefore does the check and the write in one statement
 * under a row lock, and reports whether it was the one that spent it.
 */
import { query, queryOne, transaction } from '../db/client';
import type { CreditBalance, Entitlement, Plan } from './entitlements';

export interface UserProfile {
  userId: string;
  displayName: string | null;
  sleeperUsername: string | null;
  sleeperUserId: string | null;
  preferences: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface DraftSession {
  id: string;
  userId: string;
  sleeperDraftId: string;
  leagueId: string | null;
  isMock: boolean;
  startedAt: Date;
  completedAt: Date | null;
  aiEnabled: boolean;
  aiCreditConsumed: boolean;
}

export interface Account {
  profile: UserProfile;
  entitlement: Entitlement | null;
  credits: CreditBalance;
}

/** Matches the client's `UsageRecord`, so the two are one accounting system. */
export interface DraftUsageTotals {
  calls: number;
  repairCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
  failures: number;
}

/* --------------------------------------------------------------- profiles */

/**
 * Everything about a user, creating what a first sign-in should have created.
 *
 * Idempotent, and safe to call on every request: a user who signs up and
 * immediately opens a draft must not race their own profile row into existence.
 */
export async function ensureAccount({
  userId,
  displayName,
}: {
  userId: string;
  displayName: string | null;
}): Promise<Account> {
  await query(
    `insert into user_profile (user_id, display_name)
     values ($1, $2)
     on conflict (user_id) do nothing`,
    [userId, displayName],
  );
  await query(
    `insert into ai_draft_credits (user_id) values ($1)
     on conflict (user_id) do nothing`,
    [userId],
  );
  const account = await loadAccount(userId);
  if (!account) throw new Error(`Account row missing for user ${userId} after creation.`);
  return account;
}

export async function loadAccount(userId: string): Promise<Account | null> {
  const profile = await queryOne<{
    user_id: string;
    display_name: string | null;
    sleeper_username: string | null;
    sleeper_user_id: string | null;
    preferences: Record<string, unknown>;
    created_at: Date;
    updated_at: Date;
  }>(`select * from user_profile where user_id = $1`, [userId]);
  if (!profile) return null;

  const entitlement = await queryOne<{
    plan: Plan;
    status: Entitlement['status'];
    valid_from: Date;
    valid_until: Date | null;
  }>(
    `select plan, status, valid_from, valid_until
       from entitlement
      where user_id = $1 and status = 'active'
      limit 1`,
    [userId],
  );

  const credits = await queryOne<{
    included_credits: number;
    consumed_credits: number;
    resets_at: Date | null;
    expires_at: Date | null;
  }>(
    `select included_credits, consumed_credits, resets_at, expires_at
       from ai_draft_credits where user_id = $1`,
    [userId],
  );

  return {
    profile: {
      userId: profile.user_id,
      displayName: profile.display_name,
      sleeperUsername: profile.sleeper_username,
      sleeperUserId: profile.sleeper_user_id,
      preferences: profile.preferences ?? {},
      createdAt: profile.created_at,
      updatedAt: profile.updated_at,
    },
    entitlement: entitlement
      ? {
          plan: entitlement.plan,
          status: entitlement.status,
          validFrom: entitlement.valid_from.toISOString(),
          validUntil: entitlement.valid_until?.toISOString() ?? null,
        }
      : null,
    credits: {
      includedCredits: credits?.included_credits ?? 0,
      consumedCredits: credits?.consumed_credits ?? 0,
      resetsAt: credits?.resets_at?.toISOString() ?? null,
      expiresAt: credits?.expires_at?.toISOString() ?? null,
    },
  };
}

export async function updateProfile({
  userId,
  displayName,
  sleeperUsername,
  sleeperUserId,
}: {
  userId: string;
  displayName?: string | null;
  sleeperUsername?: string | null;
  sleeperUserId?: string | null;
}): Promise<void> {
  await query(
    `update user_profile
        set display_name     = coalesce($2, display_name),
            sleeper_username = coalesce($3, sleeper_username),
            sleeper_user_id  = coalesce($4, sleeper_user_id),
            updated_at       = now()
      where user_id = $1`,
    [userId, displayName ?? null, sleeperUsername ?? null, sleeperUserId ?? null],
  );
}

/* ---------------------------------------------------------- entitlements */

/**
 * Puts a user on a plan, retiring whatever they were on.
 *
 * One statement per step inside a transaction, because the partial unique index
 * allows exactly one active row and the old one has to go first.
 */
export async function setEntitlement({
  userId,
  plan,
  validUntil = null,
  note = null,
}: {
  userId: string;
  plan: Plan;
  validUntil?: string | null;
  note?: string | null;
}): Promise<void> {
  await transaction(async (client) => {
    await client.query(
      `update entitlement set status = 'revoked', updated_at = now()
        where user_id = $1 and status = 'active'`,
      [userId],
    );
    await client.query(
      `insert into entitlement (user_id, plan, status, valid_until, note)
       values ($1, $2, 'active', $3, $4)`,
      [userId, plan, validUntil, note],
    );
  });
}

export async function grantCredits({
  userId,
  credits,
  expiresAt = null,
  resetsAt = null,
}: {
  userId: string;
  credits: number;
  expiresAt?: string | null;
  resetsAt?: string | null;
}): Promise<void> {
  await query(
    `insert into ai_draft_credits (user_id, included_credits, expires_at, resets_at)
     values ($1, $2, $3, $4)
     on conflict (user_id) do update
        set included_credits = ai_draft_credits.included_credits + excluded.included_credits,
            expires_at       = coalesce(excluded.expires_at, ai_draft_credits.expires_at),
            resets_at        = coalesce(excluded.resets_at, ai_draft_credits.resets_at),
            updated_at       = now()`,
    [userId, credits, expiresAt, resetsAt],
  );
}

/* -------------------------------------------------------- draft sessions */

export async function startDraftSession({
  userId,
  sleeperDraftId,
  leagueId,
  isMock,
}: {
  userId: string;
  sleeperDraftId: string;
  leagueId: string | null;
  isMock: boolean;
}): Promise<DraftSession> {
  const row = await queryOne<DraftSessionRow>(
    `insert into draft_session (user_id, sleeper_draft_id, league_id, is_mock)
     values ($1, $2, $3, $4)
     on conflict (user_id, sleeper_draft_id) do update
        set league_id  = coalesce(excluded.league_id, draft_session.league_id),
            updated_at = now()
     returning *`,
    [userId, sleeperDraftId, leagueId, isMock],
  );
  if (!row) throw new Error('Draft session could not be created.');
  return toDraftSession(row);
}

export async function findDraftSession(
  userId: string,
  sleeperDraftId: string,
): Promise<DraftSession | null> {
  const row = await queryOne<DraftSessionRow>(
    `select * from draft_session where user_id = $1 and sleeper_draft_id = $2`,
    [userId, sleeperDraftId],
  );
  return row ? toDraftSession(row) : null;
}

export async function completeDraftSession(sessionId: string): Promise<void> {
  await query(
    `update draft_session set completed_at = now(), updated_at = now()
      where id = $1 and completed_at is null`,
    [sessionId],
  );
}

/**
 * Spends one credit on this draft, or reports that there was none to spend.
 *
 * The whole thing is one transaction and the balance row is locked, so two
 * requests arriving together cannot both succeed - which is the only way a user
 * could be charged twice for the same draft, or once for a draft they were told
 * they could not have.
 */
export async function consumeDraftCredit({
  userId,
  sessionId,
  unmetered,
}: {
  userId: string;
  sessionId: string;
  /** Admins spend nothing, but the session is still marked AI-enabled. */
  unmetered: boolean;
}): Promise<{ consumed: boolean; creditsRemaining: number | null }> {
  return transaction(async (client) => {
    const session = await client.query<{ ai_credit_consumed: boolean }>(
      `select ai_credit_consumed from draft_session
        where id = $1 and user_id = $2 for update`,
      [sessionId, userId],
    );
    if (session.rowCount === 0) {
      throw new Error('Draft session does not belong to this user.');
    }

    const alreadyPaid = session.rows[0].ai_credit_consumed;

    if (unmetered || alreadyPaid) {
      await client.query(
        `update draft_session set ai_enabled = true, updated_at = now() where id = $1`,
        [sessionId],
      );
      return { consumed: false, creditsRemaining: unmetered ? null : null };
    }

    const spent = await client.query<{ included_credits: number; consumed_credits: number }>(
      `update ai_draft_credits
          set consumed_credits = consumed_credits + 1,
              updated_at = now()
        where user_id = $1
          and included_credits - consumed_credits > 0
          and (expires_at is null or expires_at > now())
      returning included_credits, consumed_credits`,
      [userId],
    );
    if (spent.rowCount === 0) return { consumed: false, creditsRemaining: 0 };

    await client.query(
      `update draft_session
          set ai_enabled = true, ai_credit_consumed = true, updated_at = now()
        where id = $1`,
      [sessionId],
    );
    const balance = spent.rows[0];
    return {
      consumed: true,
      creditsRemaining: Math.max(0, balance.included_credits - balance.consumed_credits),
    };
  });
}

/* ------------------------------------------------------------- AI usage */

export async function recordAiUsage(entry: {
  userId: string;
  draftSessionId: string;
  model: string | null;
  repairCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
  succeeded: boolean;
}): Promise<void> {
  await query(
    `insert into ai_usage (
       user_id, draft_session_id, model, repair_calls,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
       estimated_cost_usd, succeeded
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      entry.userId,
      entry.draftSessionId,
      entry.model,
      entry.repairCalls,
      entry.inputTokens,
      entry.outputTokens,
      entry.cacheReadTokens,
      entry.cacheWriteTokens,
      entry.estimatedCostUsd,
      entry.succeeded,
    ],
  );
}

/** The per-draft total, in the exact shape the client already renders. */
export async function draftUsageTotals(sessionId: string): Promise<DraftUsageTotals> {
  const row = await queryOne<{
    calls: string;
    repair_calls: string;
    input_tokens: string;
    output_tokens: string;
    cache_read_tokens: string;
    cache_write_tokens: string;
    estimated_cost_usd: string;
    failures: string;
  }>(
    `select coalesce(sum(calls), 0)               as calls,
            coalesce(sum(repair_calls), 0)        as repair_calls,
            coalesce(sum(input_tokens), 0)        as input_tokens,
            coalesce(sum(output_tokens), 0)       as output_tokens,
            coalesce(sum(cache_read_tokens), 0)   as cache_read_tokens,
            coalesce(sum(cache_write_tokens), 0)  as cache_write_tokens,
            coalesce(sum(estimated_cost_usd), 0)  as estimated_cost_usd,
            coalesce(sum(case when succeeded then 0 else 1 end), 0) as failures
       from ai_usage where draft_session_id = $1`,
    [sessionId],
  );
  return {
    calls: Number(row?.calls ?? 0),
    repairCalls: Number(row?.repair_calls ?? 0),
    inputTokens: Number(row?.input_tokens ?? 0),
    outputTokens: Number(row?.output_tokens ?? 0),
    cacheReadTokens: Number(row?.cache_read_tokens ?? 0),
    cacheWriteTokens: Number(row?.cache_write_tokens ?? 0),
    estimatedCostUsd: Number(row?.estimated_cost_usd ?? 0),
    failures: Number(row?.failures ?? 0),
  };
}

interface DraftSessionRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  sleeper_draft_id: string;
  league_id: string | null;
  is_mock: boolean;
  started_at: Date;
  completed_at: Date | null;
  ai_enabled: boolean;
  ai_credit_consumed: boolean;
}

function toDraftSession(row: DraftSessionRow): DraftSession {
  return {
    id: row.id,
    userId: row.user_id,
    sleeperDraftId: row.sleeper_draft_id,
    leagueId: row.league_id,
    isMock: row.is_mock,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    aiEnabled: row.ai_enabled,
    aiCreditConsumed: row.ai_credit_consumed,
  };
}
