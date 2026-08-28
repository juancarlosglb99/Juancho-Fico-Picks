-- The application's own model: who you are to the product, what you are
-- entitled to, and what the AI has cost.
--
-- Two decisions worth stating.
--
-- A CREDIT BUYS A DRAFT, not a request. `draft_session.ai_credit_consumed`
-- records that this draft has been paid for, which is why a drafter who runs
-- out mid-draft still gets answers for the rest of it - stopping at pick nine
-- would be the worst possible moment.
--
-- `ai_usage` IS ONE ROW PER CALL, not a per-session aggregate. The aggregate is
-- a query over it, and it is the same shape the client's `UsageLedger` already
-- speaks, so the two are one accounting system with the database as the
-- authority rather than two that quietly disagree.

create extension if not exists "pgcrypto";

create table if not exists user_profile (
  user_id text primary key references "user" ("id") on delete cascade,
  display_name text,
  sleeper_username text,
  sleeper_user_id text,
  preferences jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists user_profile_sleeper_user_id_idx
  on user_profile (sleeper_user_id);

create table if not exists entitlement (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references "user" ("id") on delete cascade,
  plan text not null check (plan in ('basic', 'pro', 'admin')),
  status text not null check (status in ('active', 'expired', 'revoked')),
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One active entitlement per user, enforced by the database rather than by
-- remembering to check: two active rows would make "which plan" ambiguous at
-- exactly the moment money is involved.
create unique index if not exists entitlement_one_active_per_user
  on entitlement (user_id) where status = 'active';

create table if not exists ai_draft_credits (
  user_id text primary key references "user" ("id") on delete cascade,
  included_credits integer not null default 0 check (included_credits >= 0),
  consumed_credits integer not null default 0 check (consumed_credits >= 0),
  period_started_at timestamptz not null default now(),
  resets_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists draft_session (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references "user" ("id") on delete cascade,
  sleeper_draft_id text not null,
  league_id text,
  is_mock boolean not null default false,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  ai_enabled boolean not null default false,
  ai_credit_consumed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One session per user per draft: re-entering a room you already paid for
  -- must not be able to charge you twice.
  unique (user_id, sleeper_draft_id)
);

create index if not exists draft_session_user_started_idx
  on draft_session (user_id, started_at desc);

create table if not exists ai_usage (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references "user" ("id") on delete cascade,
  draft_session_id uuid not null references draft_session (id) on delete cascade,
  model text,
  -- One call. `repair_calls` counts the second attempts inside it, which are
  -- billed like any other call and are worth being able to see separately.
  calls integer not null default 1,
  repair_calls integer not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cache_read_tokens bigint not null default 0,
  cache_write_tokens bigint not null default 0,
  estimated_cost_usd numeric(12, 6) not null default 0,
  succeeded boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists ai_usage_session_idx on ai_usage (draft_session_id);
create index if not exists ai_usage_user_created_idx on ai_usage (user_id, created_at desc);
