-- ============================================================================
-- Supplement Stack Evaluator — Supabase schema
-- ============================================================================
-- Paste this whole file into the Supabase SQL Editor and run it.
-- Safe to re-run: types, tables, indexes, policies and triggers are all
-- created idempotently (IF NOT EXISTS / DROP ... IF EXISTS patterns).
--
-- Tables:
--   profiles     One row per user (1:1 with auth.users). Stores the user's
--                stated goals, optional monthly supplement budget, and an
--                optional blood work blob used as extra context for verdicts.
--   stack_items  The ingredients a user currently takes (ingredient-level
--                only — no brands or products). Source of "current" items
--                that assessments are generated for.
--   assessments  One row per verdict the tool produces for an ingredient
--                (either a "current" item being kept/removed, or a
--                "candidate" ingredient being recommended or not), tied to
--                a snapshot of the user's goals at evaluation time.
--
-- Out of scope for v1 (intentionally not included): diet fields, brand /
-- product / price comparison tables, and any fixed ingredient lookup or
-- evidence table — verdicts are produced by reasoning, not a lookup DB.
-- ============================================================================

-- Needed for gen_random_uuid(); already enabled on Supabase projects by
-- default, but declared here so this script is self-contained.
create extension if not exists "pgcrypto";

-- ----------------------------------------------------------------------------
-- Enum types (created idempotently — CREATE TYPE has no IF NOT EXISTS)
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'item_type_enum') then
    create type item_type_enum as enum ('current', 'candidate');
  end if;
end$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'verdict_enum') then
    create type verdict_enum as enum ('keep', 'remove', 'take', 'dont_take');
  end if;
end$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'confidence_enum') then
    create type confidence_enum as enum ('strong', 'moderate', 'weak', 'insufficient_evidence');
  end if;
end$$;

-- ----------------------------------------------------------------------------
-- profiles
-- ----------------------------------------------------------------------------
-- Note on new-user provisioning: goals are required (NOT NULL, non-empty)
-- because a meaningful goal list is collected during onboarding, before any
-- evaluation can happen. An auth.users trigger can't populate a real goal
-- list at signup time, and defaulting to an empty array isn't allowed here,
-- so we deliberately skip an auto-create-profile trigger. The app should
-- insert the profiles row itself once the user submits their onboarding
-- goals (a plain `insert into profiles (id, goals, ...) values (...)`).
create table if not exists profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  goals text[] not null,
  monthly_budget numeric,
  blood_work jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_goals_not_empty check (cardinality(goals) > 0)
);

comment on table profiles is 'One row per user; stores stated goals, optional budget and optional blood work context.';
comment on column profiles.goals is 'Specific, testable goals (e.g. "build muscle"), not vague ones (e.g. "overall wellness").';

-- ----------------------------------------------------------------------------
-- stack_items
-- ----------------------------------------------------------------------------
create table if not exists stack_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles (id) on delete cascade,
  ingredient_name text not null,
  dose text,
  created_at timestamptz not null default now(),
  unique (user_id, ingredient_name)
);

comment on table stack_items is 'Ingredients a user currently takes (ingredient-level only, no brands/products).';

create index if not exists idx_stack_items_user_id on stack_items (user_id);

-- ----------------------------------------------------------------------------
-- assessments
-- ----------------------------------------------------------------------------
create table if not exists assessments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles (id) on delete cascade,
  ingredient_name text not null,
  item_type item_type_enum not null,
  verdict verdict_enum not null,
  confidence confidence_enum not null,
  reason text not null,
  mechanism text not null,
  evidence_type text,
  goals_snapshot text[] not null,
  created_at timestamptz not null default now(),
  constraint assessments_verdict_matches_item_type check (
    (item_type = 'current' and verdict in ('keep', 'remove'))
    or (item_type = 'candidate' and verdict in ('take', 'dont_take'))
  )
);

comment on table assessments is 'One row per verdict produced for an ingredient, tied to a snapshot of the user''s goals at evaluation time.';
comment on column assessments.reason is 'Why this verdict was reached, tied to the user''s stated goals.';
comment on column assessments.mechanism is 'What the ingredient does in the body and how.';

create index if not exists idx_assessments_user_id on assessments (user_id);

-- ----------------------------------------------------------------------------
-- Row Level Security
-- ----------------------------------------------------------------------------
alter table profiles enable row level security;
alter table stack_items enable row level security;
alter table assessments enable row level security;

-- profiles: auth.uid() = id
drop policy if exists "profiles_select_own" on profiles;
create policy "profiles_select_own" on profiles
  for select using (auth.uid() = id);

drop policy if exists "profiles_insert_own" on profiles;
create policy "profiles_insert_own" on profiles
  for insert with check (auth.uid() = id);

drop policy if exists "profiles_update_own" on profiles;
create policy "profiles_update_own" on profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "profiles_delete_own" on profiles;
create policy "profiles_delete_own" on profiles
  for delete using (auth.uid() = id);

-- stack_items: auth.uid() = user_id
drop policy if exists "stack_items_select_own" on stack_items;
create policy "stack_items_select_own" on stack_items
  for select using (auth.uid() = user_id);

drop policy if exists "stack_items_insert_own" on stack_items;
create policy "stack_items_insert_own" on stack_items
  for insert with check (auth.uid() = user_id);

drop policy if exists "stack_items_update_own" on stack_items;
create policy "stack_items_update_own" on stack_items
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "stack_items_delete_own" on stack_items;
create policy "stack_items_delete_own" on stack_items
  for delete using (auth.uid() = user_id);

-- assessments: auth.uid() = user_id
drop policy if exists "assessments_select_own" on assessments;
create policy "assessments_select_own" on assessments
  for select using (auth.uid() = user_id);

drop policy if exists "assessments_insert_own" on assessments;
create policy "assessments_insert_own" on assessments
  for insert with check (auth.uid() = user_id);

drop policy if exists "assessments_update_own" on assessments;
create policy "assessments_update_own" on assessments
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "assessments_delete_own" on assessments;
create policy "assessments_delete_own" on assessments
  for delete using (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- Triggers
-- ----------------------------------------------------------------------------

-- Auto-update profiles.updated_at on every update.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_profiles_updated_at on profiles;
create trigger set_profiles_updated_at
  before update on profiles
  for each row
  execute function public.set_updated_at();
