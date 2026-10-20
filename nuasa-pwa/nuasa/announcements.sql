-- Run once in Supabase: SQL Editor > New query > paste > Run.
-- Adds announcements (shown on the home page and as a one-time popup).

create or replace function public.nuasa_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
$$;

create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text,
  kind text not null default 'info',
  link_url text,
  link_label text,
  popup boolean not null default true,
  active boolean not null default true,
  expires_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now()
);
alter table public.announcements enable row level security;

drop policy if exists "announcements public read" on public.announcements;
create policy "announcements public read" on public.announcements for select to anon, authenticated
  using (active and (expires_at is null or expires_at > now()));
drop policy if exists "nuasa admin all" on public.announcements;
create policy "nuasa admin all" on public.announcements for all to authenticated
  using (public.nuasa_is_admin()) with check (public.nuasa_is_admin());
