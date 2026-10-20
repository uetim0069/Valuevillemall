-- Run this once in Supabase: Dashboard > SQL Editor > New query > paste > Run.

-- 1. "General / All" section: allow library files that belong to no course.
alter table public.resources alter column course_id drop not null;

-- 2. Project AI Studio: tracks usage so the free AI quota is not used up.
create table if not exists public.project_usage (
  id bigserial primary key,
  user_id uuid not null,
  section text not null,
  created_at timestamptz not null default now()
);
create index if not exists project_usage_user_time on public.project_usage (user_id, created_at desc);
create index if not exists project_usage_time on public.project_usage (created_at desc);
alter table public.project_usage enable row level security;
-- (No policies on purpose: only the server function, using the service key, can read or write it.)
