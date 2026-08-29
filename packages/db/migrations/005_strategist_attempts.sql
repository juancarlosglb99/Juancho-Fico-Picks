-- One row per strategist ATTEMPT, so a failure can be diagnosed without paying
-- to reproduce it.
--
-- Written after a live mock in which the AI worked for one pick and then failed
-- twelve times in a row. What we had was `ai_usage`: thirteen rows, output
-- tokens zero, $2.51. What we could not answer - because none of it was kept -
-- was whether the model returned a truncated tool call, no tool call at all, or
-- whether the provider rejected the request outright. Those are three different
-- incidents with three different fixes, and telling them apart needed a stop
-- reason and a list of content-block types: about eighty bytes we had thrown
-- away.
--
-- WHAT IS DELIBERATELY NOT HERE: prompt text, player data, tool input values,
-- and anything key-shaped. Shape, not content. A `tool_input_key_count` of 0 is
-- the signature of a truncated tool call, and that is the whole question - the
-- values are the customer's draft and are none of the audit's business.
create table if not exists ai_attempt (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references "user" ("id") on delete cascade,
  draft_session_id uuid not null references draft_session (id) on delete cascade,

  -- Which board, and which of our selections. Both come from the state the
  -- client echoes, so an attempt can be tied to a pick after the fact.
  board_fingerprint text,
  selection_key text,

  -- 0 for the primary call, 1 for the repair.
  attempt_index integer not null default 0,
  is_repair boolean not null default false,
  model text,

  -- 'answered' | 'malformed' | 'no_tool_use' | 'provider_error' | 'aborted'
  outcome text,
  -- Anthropic's own: 'end_turn', 'tool_use', 'max_tokens', 'refusal', ...
  stop_reason text,
  content_block_types text[],
  had_tool_use boolean,
  tool_name text,
  tool_input_key_count integer,

  -- The validator's fault codes, e.g. {'recommendedPlayerId','urgency'}. Field
  -- NAMES only: which part of the contract broke, never what was in it.
  validation_faults text[],

  -- Provider-side failure, which is how "we are throttled" and "the account is
  -- out of credit" stop looking identical.
  provider_status integer,
  provider_error_type text,

  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cache_read_tokens bigint not null default 0,
  cache_write_tokens bigint not null default 0,
  estimated_cost_usd numeric(12, 6) not null default 0,
  latency_ms integer,

  created_at timestamptz not null default now()
);

create index if not exists ai_attempt_session_idx on ai_attempt (draft_session_id, created_at);
create index if not exists ai_attempt_outcome_idx on ai_attempt (outcome, created_at desc);
