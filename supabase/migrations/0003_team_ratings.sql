-- World ranking + tournament tiers, sourced from datdota by the hourly
-- GitHub Action.
--
-- Why the Action and not the Edge Function: datdota sits behind Cloudflare and
-- returns 403 "cfattack" to Supabase's Deno Deploy egress regardless of
-- User-Agent (verified 2026-07-26 from the deployed runtime). The Action runs
-- on GitHub's network, fetches once an hour, and writes here; the Edge
-- Function just reads these tables. This also keeps us inside datdota's
-- "one request per 3 seconds" guidance permanently, and the last good values
-- survive any datdota outage.

create table if not exists public.team_ratings (
  valve_id    bigint primary key,
  name        text,
  glicko      int,
  glicko_prev int,            -- rating 7 days ago, for the trend arrow
  rd          int,            -- Glicko deviation; high = provisional
  region      text,
  as_of       timestamptz,    -- datdota's own rating date, not our fetch time
  updated_at  timestamptz not null default now()
);

create table if not exists public.league_tiers (
  league_id  bigint primary key,
  name       text,
  tier       text,            -- PREMIUM | PROFESSIONAL | SEMI_PRO | AMATEUR
  first_game timestamptz,
  last_game  timestamptz,
  games      int,
  tags       text[],
  updated_at timestamptz not null default now()
);

alter table public.team_ratings enable row level security;
alter table public.league_tiers enable row level security;

drop policy if exists "team_ratings readable" on public.team_ratings;
drop policy if exists "league_tiers readable" on public.league_tiers;
create policy "team_ratings readable" on public.team_ratings for select using (true);
create policy "league_tiers readable" on public.league_tiers for select using (true);

grant select on public.team_ratings, public.league_tiers to anon, authenticated;
grant select, insert, update, delete on public.team_ratings, public.league_tiers to service_role;
