-- Let a signed-in user change their own nickname.
--
-- A nickname lives in TWO places and both must move together:
--   profiles.username        -> what username login resolves (email_for_username)
--   league_members.username  -> a copy snapshotted when you joined a league, and
--                               the one league_leaderboard, league_members_list
--                               and get_match_predictions actually display.
-- Updating only profiles would let someone rename themselves and still see the
-- old name on every leaderboard, which reads as the feature being broken.

create or replace function public.set_username(p_username text)
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  uid   uuid := auth.uid();
  clean text;
begin
  if uid is null then
    raise exception 'You need to be signed in to change your nickname.'
      using errcode = '28000';
  end if;

  clean := trim(coalesce(p_username, ''));
  -- Same rule the sign-up form enforces, so a nickname chosen here can never be
  -- one that sign-up would have rejected.
  if clean !~ '^[a-zA-Z0-9_.]{3,20}$' then
    raise exception 'Nickname must be 3-20 characters, using letters, numbers, _ or . only.'
      using errcode = '22023';
  end if;

  -- Case-insensitive, so "Andrei" and "andrei" cannot both exist and become
  -- impossible to tell apart in a leaderboard.
  if exists (select 1 from profiles
             where lower(username) = lower(clean) and id <> uid) then
    raise exception 'That nickname is already taken.' using errcode = '23505';
  end if;

  update profiles set username = clean where id = uid;
  if not found then
    insert into profiles (id, username) values (uid, clean)
    on conflict (id) do update set username = excluded.username;
  end if;

  update league_members set username = clean where user_id = uid;

  return clean;
end $$;

-- Only a signed-in user, and only for themselves (uid comes from the JWT, never
-- from an argument). Anon must not be able to call this at all.
revoke execute on function public.set_username(text) from public, anon;
grant execute on function public.set_username(text) to authenticated;
