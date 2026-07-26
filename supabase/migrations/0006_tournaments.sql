-- ---------------------------------------------------------------------------
-- User-created tournaments.
--
-- v1 formats: single elimination and round robin, 2 teams upward, with the
-- series length choosable per stage (Bo1 / Bo3 / Bo5) and an optional
-- third-place match.
--
-- Design notes:
--  * A tournament is generated ONCE, server-side, into concrete match rows.
--    Brackets are not computed on the fly — every match is a real row with a
--    pointer to where its winner goes, so the bracket can be read, scheduled
--    and reported against like any other match.
--  * Seeding uses the standard bracket order (1v8, 4v5, 2v7, 3v6 for eight),
--    so the strongest teams meet last rather than in round one.
--  * Byes are filled and auto-advanced at generation time; nobody is asked to
--    play an empty slot.
-- ---------------------------------------------------------------------------

create table if not exists public.tournaments (
  id             uuid primary key default gen_random_uuid(),
  code           text unique not null,
  name           text not null,
  format         text not null default 'single_elim',   -- single_elim | round_robin
  organiser_id   uuid not null references auth.users(id) on delete cascade,
  max_teams      int  not null default 8,
  -- Series length per stage, resolved when the bracket is generated.
  -- {"default":3,"final":5} means Bo3 throughout with a Bo5 final.
  series_format  jsonb not null default '{"default":3,"final":5}'::jsonb,
  third_place    boolean not null default false,
  status         text not null default 'registration',  -- registration | running | finished | cancelled
  visibility     text not null default 'public',        -- public | unlisted
  description    text,
  starts_at      timestamptz,
  created_at     timestamptz not null default now(),
  started_at     timestamptz,
  finished_at    timestamptz,
  champion_id    uuid
);

create table if not exists public.tournament_teams (
  id            uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  name          text not null,
  tag           text,
  captain_id    uuid not null references auth.users(id) on delete cascade,
  seed          int,
  roster        text[],            -- player names; identity is not required to play
  joined_at     timestamptz not null default now()
);
-- One entry per name per tournament, and one team per captain per tournament.
create unique index if not exists tt_name_uniq on public.tournament_teams (tournament_id, lower(name));
create unique index if not exists tt_captain_uniq on public.tournament_teams (tournament_id, captain_id);

create table if not exists public.tournament_matches (
  id             uuid primary key default gen_random_uuid(),
  tournament_id  uuid not null references public.tournaments(id) on delete cascade,
  bracket        text not null default 'main',   -- main | third_place (upper/lower later)
  round          int  not null,
  slot           int  not null,
  label          text,                            -- "Quarter-final", "Round 2"…
  team_a         uuid references public.tournament_teams(id) on delete set null,
  team_b         uuid references public.tournament_teams(id) on delete set null,
  best_of        int not null default 3,
  scheduled_at   timestamptz,
  proposed_at    timestamptz,                     -- a time one captain suggested
  proposed_by    uuid,
  status         text not null default 'pending', -- pending | ready | reported | done
  score_a        int not null default 0,
  score_b        int not null default 0,
  winner_id      uuid references public.tournament_teams(id) on delete set null,
  dota_matches   jsonb not null default '[]'::jsonb,  -- verified Dota match ids
  reported_by    uuid,
  reported_at    timestamptz,
  confirmed_by   uuid,
  -- Where the winner goes next. Null in the final.
  next_match_id  uuid references public.tournament_matches(id) on delete set null,
  next_is_a      boolean,
  -- Where the loser goes (third-place match).
  loser_match_id uuid references public.tournament_matches(id) on delete set null,
  loser_is_a     boolean,
  updated_at     timestamptz not null default now()
);
create unique index if not exists tm_slot_uniq
  on public.tournament_matches (tournament_id, bracket, round, slot);
create index if not exists tm_tournament_idx on public.tournament_matches (tournament_id);

alter table public.tournaments        enable row level security;
alter table public.tournament_teams   enable row level security;
alter table public.tournament_matches enable row level security;

-- Tournaments are a public noticeboard: anyone can look, only the organiser
-- can change. Creating one requires being signed in and owning it.
drop policy if exists "tournaments readable"  on public.tournaments;
drop policy if exists "tournaments create"    on public.tournaments;
drop policy if exists "tournaments organiser" on public.tournaments;
create policy "tournaments readable" on public.tournaments for select using (true);
create policy "tournaments create"   on public.tournaments for insert to authenticated
  with check (organiser_id = auth.uid());
create policy "tournaments organiser" on public.tournaments for update to authenticated
  using (organiser_id = auth.uid());

drop policy if exists "teams readable" on public.tournament_teams;
drop policy if exists "teams register" on public.tournament_teams;
drop policy if exists "teams edit"     on public.tournament_teams;
drop policy if exists "teams withdraw" on public.tournament_teams;
create policy "teams readable" on public.tournament_teams for select using (true);
-- You may only register yourself, only into a tournament still taking teams,
-- and only while there is room.
create policy "teams register" on public.tournament_teams for insert to authenticated
  with check (
    captain_id = auth.uid()
    and exists (select 1 from public.tournaments t
                where t.id = tournament_id and t.status = 'registration'
                  and (select count(*) from public.tournament_teams x
                       where x.tournament_id = t.id) < t.max_teams)
  );
create policy "teams edit" on public.tournament_teams for update to authenticated
  using (captain_id = auth.uid()
         or exists (select 1 from public.tournaments t
                    where t.id = tournament_id and t.organiser_id = auth.uid()));
create policy "teams withdraw" on public.tournament_teams for delete to authenticated
  using (captain_id = auth.uid()
         or exists (select 1 from public.tournaments t
                    where t.id = tournament_id and t.organiser_id = auth.uid()));

drop policy if exists "matches readable" on public.tournament_matches;
create policy "matches readable" on public.tournament_matches for select using (true);
-- Matches are never written directly: scheduling and results go through RPCs
-- so the bracket can't be edited into a state it should never be in.

grant select on public.tournaments, public.tournament_teams, public.tournament_matches to anon, authenticated;
grant insert, update on public.tournaments to authenticated;
grant insert, update, delete on public.tournament_teams to authenticated;
grant select, insert, update, delete
  on public.tournaments, public.tournament_teams, public.tournament_matches to service_role;

-- --- helpers ---------------------------------------------------------------

-- Short shareable code, same idea as league join codes.
create or replace function public.tournament_code()
returns text language plpgsql as $$
declare c text;
begin
  loop
    c := upper(substr(md5(random()::text), 1, 5));
    exit when not exists (select 1 from tournaments where code = c);
  end loop;
  return c;
end $$;

-- Standard single-elimination seed order for a bracket of `size`.
-- size 4 -> {1,4,2,3}; size 8 -> {1,8,4,5,2,7,3,6}. Built by repeatedly
-- interleaving each seed with its mirror, which is what puts seed 1 and
-- seed 2 in opposite halves.
create or replace function public.bracket_seed_order(size int)
returns int[] language plpgsql immutable as $$
declare cur int[] := array[1]; nxt int[]; n int; i int;
begin
  while array_length(cur, 1) < size loop
    n := array_length(cur, 1);
    nxt := '{}';
    for i in 1..n loop
      nxt := nxt || cur[i] || (2 * n + 1 - cur[i]);
    end loop;
    cur := nxt;
  end loop;
  return cur;
end $$;

-- Series length for a round, from the tournament's series_format.
create or replace function public.series_len(fmt jsonb, round int, total_rounds int)
returns int language sql immutable as $$
  select coalesce(
    case
      when round = total_rounds     then (fmt ->> 'final')::int
      when round = total_rounds - 1 then (fmt ->> 'semi')::int
      else null
    end,
    (fmt ->> ('r' || round))::int,
    (fmt ->> 'default')::int,
    3);
$$;
