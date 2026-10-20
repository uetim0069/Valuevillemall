-- Run this once in Supabase (SQL Editor > New query > paste > Run) if the Admin console says "permission denied".
-- It lets accounts whose profile role is 'admin' read and edit every table the console uses.
-- It only ADDS permissions for admins. Nothing is removed and other users are not affected.

create or replace function public.nuasa_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
$$;

do $$
declare t text;
begin
  foreach t in array array['resources','courses','prep_classes','notebooks','opportunities','cbt_questions','profiles'] loop
    execute format('drop policy if exists "nuasa admin all" on public.%I', t);
    execute format('create policy "nuasa admin all" on public.%I for all to authenticated using (public.nuasa_is_admin()) with check (public.nuasa_is_admin())', t);
  end loop;
end $$;
