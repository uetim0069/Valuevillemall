-- Run once in Supabase: SQL Editor > New query > paste > Run.
-- Adds the tables behind "Report an error" and the weekly Leaderboard in CBT practice.

create table if not exists public.cbt_reports (
  id bigserial primary key,
  course_code text,
  question text,
  note text,
  user_id uuid,
  created_at timestamptz not null default now()
);
alter table public.cbt_reports enable row level security;
drop policy if exists "anyone can report" on public.cbt_reports;
create policy "anyone can report" on public.cbt_reports for insert to anon, authenticated with check (true);
drop policy if exists "nuasa admin all" on public.cbt_reports;
create policy "nuasa admin all" on public.cbt_reports for all to authenticated using (public.nuasa_is_admin()) with check (public.nuasa_is_admin());

create table if not exists public.cbt_scores (
  id bigserial primary key,
  user_id uuid not null,
  name text,
  course_code text,
  mode text,
  pct int,
  correct int,
  total int,
  seconds int,
  created_at timestamptz not null default now()
);
create index if not exists cbt_scores_time on public.cbt_scores (created_at desc);
alter table public.cbt_scores enable row level security;
drop policy if exists "scores readable" on public.cbt_scores;
create policy "scores readable" on public.cbt_scores for select to anon, authenticated using (true);
drop policy if exists "own scores insert" on public.cbt_scores;
create policy "own scores insert" on public.cbt_scores for insert to authenticated with check (user_id = auth.uid());
