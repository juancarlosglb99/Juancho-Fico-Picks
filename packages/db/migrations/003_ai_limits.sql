-- The hard ceilings on AI spending, and the switch that turns it all off.
--
-- Two things live here that could not live in application code.
--
-- CONCURRENCY IS A UNIQUE INDEX, not a check. "One active strategist request
-- per user" enforced by reading a row and then inserting one is not mutual
-- exclusion - two requests can both read zero. So an in-flight request holds a
-- lease row, and the database refuses the second insert. The lease expires on
-- its own, because a container that dies mid-call must not lock somebody out
-- of their own draft.
--
-- THE KILL SWITCH IS A ROW as well as an environment variable. The variable is
-- the deploy-time position and needs a restart; the row can be flipped in one
-- statement while a draft is running. Off wins between them, and the lower
-- spend limit wins, so no combination of the two can raise a ceiling.

create table if not exists ai_request_lease (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references "user" ("id") on delete cascade,
  draft_session_id uuid not null references draft_session (id) on delete cascade,
  -- Our overall pick number. The dedupe key, and deliberately not the board
  -- fingerprint: a correction during our own turn is the same pick, and paying
  -- twice for it is exactly what this prevents.
  selection_key text not null,
  started_at timestamptz not null default now(),
  -- A lease past this moment is dead and may be taken over.
  expires_at timestamptz not null,
  released_at timestamptz,
  outcome text check (outcome in ('answered', 'failed', 'abandoned')),
  created_at timestamptz not null default now()
);

-- One live request per user. This is the guarantee; everything else about
-- concurrency in the application is an optimisation on top of it.
create unique index if not exists ai_request_lease_one_active_per_user
  on ai_request_lease (user_id) where released_at is null;

-- One live request per draft. Subsumed by the user index today, and stated
-- anyway: it is a separate requirement and it survives the day a user is
-- allowed two drafts at once.
--
-- Keyed on the SESSION rather than the Sleeper draft id, because two people in
-- the same league have two sessions of one draft and must not block each other.
create unique index if not exists ai_request_lease_one_active_per_draft
  on ai_request_lease (draft_session_id) where released_at is null;

create index if not exists ai_request_lease_selection_idx
  on ai_request_lease (draft_session_id, selection_key);

create index if not exists ai_request_lease_expiry_idx
  on ai_request_lease (expires_at) where released_at is null;

-- Exactly one row, ever. `id boolean primary key check (id)` is the cheapest
-- honest way to say that in Postgres: there is one true, so there is one row.
create table if not exists ai_control (
  id boolean primary key default true check (id),
  enabled boolean not null default true,
  disabled_reason text,
  -- Null means "no opinion"; the environment default applies. A number here
  -- only ever lowers the ceiling.
  daily_spend_limit_usd numeric(12, 2),
  monthly_spend_limit_usd numeric(12, 2),
  updated_at timestamptz not null default now()
);

insert into ai_control (id) values (true) on conflict (id) do nothing;

-- The global spend windows are summed over `ai_usage` on every request, so the
-- scan has to stay cheap as the table grows.
create index if not exists ai_usage_created_idx on ai_usage (created_at);
