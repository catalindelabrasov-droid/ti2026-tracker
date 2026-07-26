-- Our own pro-match history, so we can compute a world ranking ourselves
-- instead of depending on datdota (which blocks every data-centre IP and so
-- can only be refreshed by hand from a home connection).
--
-- One row per SERIES, not per game: a Bo3 is a single 2-1 result, which is
-- what a rating should be updated on.

create table if not exists public.pro_series (
  series_key  text primary key,      -- OpenDota series_id, or teams+day when absent
  league_id   bigint,
  team_a_id   bigint not null,
  team_a      text,
  team_b_id   bigint not null,
  team_b      text,
  score_a     int not null default 0,
  score_b     int not null default 0,
  best_of     int,
  started_at  timestamptz,
  updated_at  timestamptz not null default now()
);

create index if not exists pro_series_started_idx on public.pro_series (started_at);

alter table public.pro_series enable row level security;
drop policy if exists "pro_series readable" on public.pro_series;
create policy "pro_series readable" on public.pro_series for select using (true);
grant select on public.pro_series to anon, authenticated;
grant select, insert, update, delete on public.pro_series to service_role;

-- Where a rating came from, so the UI can label it and we can compare our own
-- numbers against datdota's while the engine is being trusted.
alter table public.team_ratings add column if not exists source text;
alter table public.team_ratings add column if not exists games int;
update public.team_ratings set source = 'datdota' where source is null;
