-- A signup whose chosen username was already taken left the account with NO
-- profile row at all. handle_new_user() inserted "on conflict do nothing" and
-- profiles.username is UNIQUE, so the collision silently dropped the whole row.
-- The account still works by email, but username login cannot find it and the
-- member shows up nameless in leagues. One real user hit this on 12 Aug 2026 by
-- picking a name another member already had, and the signup form gave no hint:
-- it reported success and sent a confirmation mail like any other.
--
-- Never leave a user profile-less. Fall back to the email local part, then to
-- numbered variants, until one is free.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  base text;
  cand text;
  n    int := 1;
begin
  base := coalesce(nullif(trim(new.raw_user_meta_data->>'username'), ''),
                   split_part(new.email, '@', 1));
  -- keep it to what the signup form itself allows
  base := left(regexp_replace(base, '[^a-zA-Z0-9_.]', '', 'g'), 20);
  if base = '' then
    base := 'player';
  end if;

  cand := base;
  while exists (select 1 from public.profiles where lower(username) = lower(cand)) loop
    n := n + 1;
    exit when n > 999;
    cand := left(base, greatest(1, 20 - length(n::text))) || n::text;
  end loop;

  insert into public.profiles (id, username) values (new.id, cand)
  on conflict (id) do nothing;
  return new;
exception when others then
  -- never block the signup itself
  return new;
end $function$;

-- Backfill anyone already stranded without a profile.
do $$
declare
  u    record;
  base text;
  cand text;
  n    int;
begin
  for u in
    select id, email, raw_user_meta_data->>'username' as wanted
    from auth.users
    where not exists (select 1 from public.profiles p where p.id = auth.users.id)
  loop
    base := coalesce(nullif(trim(u.wanted), ''), split_part(u.email, '@', 1));
    base := left(regexp_replace(base, '[^a-zA-Z0-9_.]', '', 'g'), 20);
    if base = '' then base := 'player'; end if;
    cand := base; n := 1;
    while exists (select 1 from public.profiles where lower(username) = lower(cand)) loop
      n := n + 1;
      exit when n > 999;
      cand := left(base, greatest(1, 20 - length(n::text))) || n::text;
    end loop;
    insert into public.profiles (id, username) values (u.id, cand)
    on conflict (id) do nothing;
    raise notice 'backfilled % -> %', u.email, cand;
  end loop;
end $$;
