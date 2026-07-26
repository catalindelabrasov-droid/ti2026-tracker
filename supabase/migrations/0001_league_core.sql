-- ---------------------------------------------------------------------------
-- League core: score everything the UI shows.
--
-- Before this migration the leaderboard hard-coded "correct winner + exact
-- score" and ignored leagues.rules entirely, so most enabled toggles — and
-- every tournament-outcome pick (champion, top 4) — silently paid nothing.
--
-- This migration:
--   1. rule_on()/rule_pts()/stage_weight() helpers over the rules JSON
--   2. matches + match_games tables (schedule/participants/per-game results)
--   3. league_leaderboard() rewritten to honor the rules JSON
--   4. tournament outcomes resolved from the playoff bracket
--   5. server-side lock enforcement on predictions
--   6. get_match_predictions() reveals picks once the deadline passes
--
-- Match id conventions written by update_data.py:
--   q{leagueid}-{seriesid}  regional qualifier series
--   gs-r{n}-m{k}            Swiss group stage
--   el-r1m{n}               elimination round (3-2 vs 2-3)
--   me-r1m1..me-r5m1        playoffs; me-r4m1 UB final, me-r4m2 LB final,
--                           me-r3m1 LB semifinal, me-r5m1 grand final
-- ---------------------------------------------------------------------------

-- 1. Rule helpers ------------------------------------------------------------

create or replace function public.rule_on(r jsonb, k text, d boolean default false)
returns boolean language sql immutable as $$
  select coalesce((r -> k ->> 'on')::boolean, d);
$$;

create or replace function public.rule_pts(r jsonb, k text, d int)
returns int language sql immutable as $$
  select coalesce((r -> k ->> 'pts')::int, d);
$$;

-- Round-weighted scoring: later stages are worth more. Flat mode = 1.0.
create or replace function public.stage_weight(mid text, mode text)
returns numeric language sql immutable as $$
  select case
    when coalesce(mode, 'flat') <> 'weighted' then 1.0
    when mid like 'me-r5%' then 3.0                      -- grand final
    when mid like 'me-r4%' or mid like 'me-r3%' then 2.5 -- UB/LB finals, LB semi
    when mid like 'me-r%'  then 2.0                      -- earlier playoffs
    when mid like 'el-%'   then 1.5                      -- elimination round
    else 1.0                                             -- qualifiers, Swiss
  end;
$$;

-- 2. Schedule + per-game tables ---------------------------------------------

create table if not exists public.matches (
  match_id     text primary key,
  team_a       text,
  team_b       text,
  best_of      int,
  scheduled_at timestamptz,
  stage        text,          -- qualifier | group | elimination | playoffs
  status       text,          -- upcoming | live | completed
  updated_at   timestamptz not null default now()
);

create table if not exists public.match_games (
  match_id   text not null,
  game_no    int  not null,
  winner     text,
  duration   int,             -- seconds
  start_time timestamptz,
  primary key (match_id, game_no)
);

alter table public.matches      enable row level security;
alter table public.match_games  enable row level security;

drop policy if exists "matches readable"     on public.matches;
drop policy if exists "match_games readable" on public.match_games;
create policy "matches readable"     on public.matches     for select using (true);
create policy "match_games readable" on public.match_games for select using (true);

grant select on public.matches, public.match_games to anon, authenticated;
-- The hourly updater writes these with the service-role key.
grant select, insert, update on public.matches, public.match_games to service_role;
grant select, insert, update on public.match_results to service_role;

-- 3+4. Leaderboard that honors the rules JSON, including outcomes -----------

-- Dropped rather than replaced: the return type gains exact_hits and
-- outcome_points, which CREATE OR REPLACE cannot do.
drop function if exists public.league_leaderboard(uuid);

create or replace function public.league_leaderboard(p_league uuid)
returns table(
  username       text,
  points         int,
  correct        int,
  scored         int,
  exact_hits     int,
  outcome_points int
)
language sql
security definer
set search_path to 'public'
as $function$
with r as (
  select coalesce(rules, '{}'::jsonb) as rules from leagues where id = p_league
),
-- How many league members backed each pick (for the lone-wolf bonus).
consensus as (
  select match_id, pick,
         count(*)::numeric
           / nullif(sum(count(*)) over (partition by match_id), 0) as share
  from predictions
  where league_id = p_league and locked
  group by match_id, pick
),
game1 as (
  select match_id, winner from match_games where game_no = 1
),
per_match as (
  select
    p.user_id,
    (p.pick = res.winner) as is_correct,
    (p.pick = res.winner and p.score_a = res.score_a
       and p.score_b = res.score_b) as is_exact,
    round((
        case when rule_on(r.rules, 'winner', true) and p.pick = res.winner
             then rule_pts(r.rules, 'winner', 10) else 0 end
      + case when rule_on(r.rules, 'exactScore', true) and p.pick = res.winner
                  and p.score_a = res.score_a and p.score_b = res.score_b
             then rule_pts(r.rules, 'exactScore', 15) else 0 end
      -- Total games called right, whoever won.
      + case when rule_on(r.rules, 'gameCountOU')
                  and (p.score_a + p.score_b) = (res.score_a + res.score_b)
             then rule_pts(r.rules, 'gameCountOU', 6) else 0 end
      -- Backed a winner almost nobody in the league did.
      + case when rule_on(r.rules, 'loneWolf') and p.pick = res.winner
                  and c.share <= 0.25
             then rule_pts(r.rules, 'loneWolf', 5) else 0 end
      -- Your team took the opening game of the series.
      + case when rule_on(r.rules, 'firstGame') and g.winner is not null
                  and p.pick = g.winner
             then rule_pts(r.rules, 'firstGame', 5) else 0 end
      -- Called a series won by the side that dropped game 1.
      + case when rule_on(r.rules, 'reverseSweep') and p.pick = res.winner
                  and g.winner is not null and g.winner <> res.winner
             then rule_pts(r.rules, 'reverseSweep', 12) else 0 end
      + case when rule_on(r.rules, 'negativePoints') and p.pick <> res.winner
             then -rule_pts(r.rules, 'negativePoints', 5) else 0 end
    ) * stage_weight(p.match_id, r.rules ->> 'scoreMode'))::int as pts
  from predictions p
  cross join r
  join match_results res on res.match_id = p.match_id
  left join consensus c on c.match_id = p.match_id and c.pick = p.pick
  left join game1 g     on g.match_id = p.match_id
  where p.league_id = p_league and p.locked
),
match_totals as (
  select user_id,
         sum(pts)::int as pts,
         count(*) filter (where is_correct)::int as correct,
         count(*)::int as scored,
         count(*) filter (where is_exact)::int as exact_hits
  from per_match group by user_id
),
-- Actual tournament outcomes, derived from the playoff bracket. `matches`
-- supplies participants (match_results only records the winner).
actual as (
  select
    (select winner from match_results where match_id = 'me-r5m1') as champion,
    (select winner from match_results where match_id = 'me-r4m2') as lb_final_winner,
    (select array_agg(t) from (
        select unnest(array[team_a, team_b]) t from matches where match_id = 'me-r5m1'
     ) x where t is not null and t <> 'TBD')                      as finalists,
    -- Last four standing = UB finalists + LB semifinalists.
    (select array_agg(distinct t) from (
        select unnest(array[team_a, team_b]) t from matches
        where match_id in ('me-r4m1', 'me-r3m1')
     ) x where t is not null and t <> 'TBD')                      as top4,
    -- Everyone who reached the playoff bracket.
    (select array_agg(distinct t) from (
        select unnest(array[team_a, team_b]) t from matches
        where match_id like 'me-r1m%'
     ) x where t is not null and t <> 'TBD')                      as top8
),
outcome_totals as (
  select o.user_id, sum(
    case o.kind
      when 'champion' then (
        case when rule_on(r.rules, 'champion', true)
                  and a.champion is not null
                  and (o.value #>> '{}') = a.champion
             then rule_pts(r.rules, 'champion', 50) else 0 end
        -- Bonus when that champion came up through the lower bracket.
      + case when rule_on(r.rules, 'champFromLB')
                  and a.champion is not null
                  and (o.value #>> '{}') = a.champion
                  and a.champion = a.lb_final_winner
             then rule_pts(r.rules, 'champFromLB', 20) else 0 end)
      when 'grandFinalists' then
        case when rule_on(r.rules, 'grandFinalists', true) and a.finalists is not null
             then rule_pts(r.rules, 'grandFinalists', 25)
                  * (select count(*) from jsonb_array_elements_text(o.value) e(t)
                     where e.t = any(a.finalists))::int
             else 0 end
      when 'topFour' then
        case when rule_on(r.rules, 'topFour', true) and a.top4 is not null
             then rule_pts(r.rules, 'topFour', 20)
                  * (select count(*) from jsonb_array_elements_text(o.value) e(t)
                     where e.t = any(a.top4))::int
             else 0 end
      when 'topEight' then
        case when rule_on(r.rules, 'topEight') and a.top8 is not null
             then rule_pts(r.rules, 'topEight', 10)
                  * (select count(*) from jsonb_array_elements_text(o.value) e(t)
                     where e.t = any(a.top8))::int
             else 0 end
      else 0
    end)::int as pts
  from outcome_predictions o
  cross join r
  cross join actual a
  where o.league_id = p_league and o.locked
  group by o.user_id
)
select
  m.username,
  (coalesce(mt.pts, 0) + coalesce(ot.pts, 0))::int as points,
  coalesce(mt.correct, 0)                          as correct,
  coalesce(mt.scored, 0)                           as scored,
  coalesce(mt.exact_hits, 0)                       as exact_hits,
  coalesce(ot.pts, 0)                              as outcome_points
from league_members m
cross join r
left join match_totals   mt on mt.user_id = m.user_id
left join outcome_totals ot on ot.user_id = m.user_id
where m.league_id = p_league
order by
  points desc,
  -- Tie-breakers, applied only when the league enables them.
  (case when rule_on(r.rules, 'tbExactHits', true)
        then coalesce(mt.exact_hits, 0) else 0 end) desc,
  (case when rule_on(r.rules, 'tbChampion', true)
        then coalesce(ot.pts, 0) else 0 end) desc,
  coalesce(mt.correct, 0) desc,
  m.username;
$function$;

-- 5. Server-side lock enforcement -------------------------------------------
-- The client also checks, but the server is the source of truth: a prediction
-- may not be created or changed once its deadline passed or the result landed.

create or replace function public.enforce_prediction_lock()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_sched   timestamptz;
  v_status  text;
  v_lead_ms bigint;
begin
  if exists (select 1 from match_results where match_id = new.match_id) then
    raise exception 'This match already has a result — predictions are closed.'
      using errcode = 'P0001';
  end if;

  select scheduled_at, status into v_sched, v_status
    from matches where match_id = new.match_id;

  -- Liquipedia often has no date until editors fill it in, so also refuse
  -- once a match is under way — otherwise an undated live match stays open.
  if v_status in ('live', 'completed') then
    raise exception 'This match has already started — predictions are closed.'
      using errcode = 'P0001';
  end if;

  if v_sched is null then
    return new;  -- schedule unknown and not started: nothing to enforce yet
  end if;

  select coalesce((rules ->> 'lockLeadMs')::bigint, 3600000)
    into v_lead_ms from leagues where id = new.league_id;

  if now() > v_sched - make_interval(secs => v_lead_ms / 1000.0) then
    raise exception 'Predictions for this match are locked (deadline passed).'
      using errcode = 'P0001';
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_enforce_prediction_lock on public.predictions;
create trigger trg_enforce_prediction_lock
  before insert or update on public.predictions
  for each row execute function public.enforce_prediction_lock();

-- 6. Reveal picks once the deadline passes ----------------------------------
-- Banter is the product: hiding everyone's picks after the deadline (just
-- because you didn't pick) removes the reason to open the app during a match.
-- Also adds the league-membership check the old version was missing.

create or replace function public.get_match_predictions(p_league uuid, p_match text)
returns table(username text, pick text, score_a int, score_b int)
language sql
security definer
set search_path to 'public'
as $function$
  select m.username, p.pick, p.score_a, p.score_b
  from predictions p
  join league_members m
    on m.league_id = p.league_id and m.user_id = p.user_id
  where p.league_id = p_league
    and p.match_id  = p_match
    and p.locked = true
    and is_league_member(p_league, auth.uid())
    and (
      -- you already locked your own pick for this match
      exists (
        select 1 from predictions me
        where me.league_id = p_league and me.match_id = p_match
          and me.user_id = auth.uid() and me.locked = true
      )
      -- or the result is in
      or exists (select 1 from match_results mr where mr.match_id = p_match)
      -- or the lock deadline has passed
      or exists (
        select 1 from matches mt
        cross join leagues l
        where mt.match_id = p_match and l.id = p_league
          and mt.scheduled_at is not null
          and now() > mt.scheduled_at
                      - make_interval(secs => coalesce(
                          (l.rules ->> 'lockLeadMs')::bigint, 3600000) / 1000.0)
      )
    );
$function$;
