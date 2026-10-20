-- Run once in Supabase: SQL Editor > New query > paste > Run.
-- Adds: CITN classes, the Videos section, and bigger video uploads.

-- 1. Let prep_classes accept CITN (removes old exam/level CHECK rules, or extends an enum if one is used).
do $$ declare c record; t text;
begin
  for c in select conname from pg_constraint
           where conrelid = 'public.prep_classes'::regclass and contype = 'c'
             and (pg_get_constraintdef(oid) ilike '%exam%' or pg_get_constraintdef(oid) ilike '%level%') loop
    execute format('alter table public.prep_classes drop constraint %I', c.conname);
  end loop;
  select udt_name into t from information_schema.columns
   where table_schema = 'public' and table_name = 'prep_classes' and column_name = 'exam';
  if t is not null and exists (select 1 from pg_type where typname = t and typtype = 'e') then
    execute format('alter type public.%I add value if not exists %L', t, 'CITN');
  end if;
end $$;

-- 2. Admin check (same as admin-permissions.sql, safe to run again).
create or replace function public.nuasa_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
$$;

-- 3. Videos table.
create table if not exists public.videos (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  category text not null default 'General',
  video_url text,
  video_path text,
  file_size bigint,
  status text not null default 'pending',
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists videos_status_time on public.videos (status, created_at desc);
alter table public.videos enable row level security;

drop policy if exists "videos public read" on public.videos;
create policy "videos public read" on public.videos for select to anon, authenticated using (status = 'approved');
drop policy if exists "videos own read" on public.videos;
create policy "videos own read" on public.videos for select to authenticated using (created_by = auth.uid());
drop policy if exists "videos submit" on public.videos;
create policy "videos submit" on public.videos for insert to authenticated with check (created_by = auth.uid() and status = 'pending');
drop policy if exists "nuasa admin all" on public.videos;
create policy "nuasa admin all" on public.videos for all to authenticated using (public.nuasa_is_admin()) with check (public.nuasa_is_admin());

-- 4. Remove the per-file limit of the "library" bucket (the project-wide limit still applies).
-- NOTE: Supabase also has a project-wide limit (Dashboard > Storage > Settings > "Upload file size limit").
-- The free plan caps it at 50 MB; on the Pro plan you can raise it to 500 MB or more. The lower of the two wins.
update storage.buckets set file_size_limit = null where id = 'library';
