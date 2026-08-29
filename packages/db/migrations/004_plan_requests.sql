-- What somebody ASKED for, and whether they switched AI on for a draft.
--
-- Two columns on tables that already exist, deliberately not two new tables:
-- the account model already knows who a user is and what a draft session is,
-- and a parallel "signup intent" store would be a second place to look for the
-- answer to "what is this person supposed to have".
--
-- REQUESTED_PLAN IS NOT AN ENTITLEMENT. It records that a person clicked
-- "Choose Pro", nothing more. Access still comes from the `entitlement` table
-- and is still granted by a human. The two are separate columns on separate
-- tables with different names because the commercial failure mode here is the
-- day somebody wires them together and choosing a plan starts granting one.
alter table user_profile
  add column if not exists requested_plan text
    check (requested_plan is null or requested_plan in ('basic', 'pro'));

alter table user_profile
  add column if not exists requested_plan_at timestamptz;

-- Did the drafter explicitly turn the strategist on for THIS draft?
--
-- A credit buys a draft, and this is the moment a person chooses to spend one.
-- Opening a draft, watching one, or running a mock leaves this false and costs
-- nothing. `ai_credit_consumed` still records whether the charge actually
-- happened, because asking for AI and being allowed AI are different events and
-- the gap between them is where refusals live.
alter table draft_session
  add column if not exists ai_requested boolean not null default false;

alter table draft_session
  add column if not exists ai_requested_at timestamptz;

-- The admin list sorts by "who is waiting", so it reads this constantly.
create index if not exists user_profile_requested_plan_idx
  on user_profile (requested_plan) where requested_plan is not null;
