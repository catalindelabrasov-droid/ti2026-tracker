-- More ways to earn points.
--
-- Several of these were cut in migration 0001 because the data didn't exist.
-- It does now:
--   * team_ratings gives every team a world rating, so we can finally tell an
--     upset from a routine win.
--   * matches.scheduled_at lets us group picks by calendar day.
--   * match_games gives per-game results (already used by firstGame /
--     reverseSweep).
--
-- Every rule below is scored server-side, so nothing is shown in the UI that
-- the leaderboard ignores.

drop function if exists public.league_leaderboard(uuid);

create or replace function public.league_leaderboard(p_league uuid)
returns table(
  username       text,
  points         int,
  correct        int,
  scored         int,
  exact_hits     int,
  outcome_points int,
  best_streak    int
)
language sql
security definer
set search_path to 'public'
as $function$
with r as (
  select coalesce(rules, '{}'::jsonb) as rules from leagues where id = p_league
),
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
-- One row per settled prediction, with everything later rules need.
base as (
  select
    p.user_id,
    p.match_id,
    m.scheduled_at,
    (p.pick = res.winner)                                    as is_correct,
    (p.pick = res.winner and p.score_a = res.score_a
       and p.score_b = res.score_b)                          as is_exact,
    -- The beaten side scored nothing.
    (p.pick = res.winner and least(res.score_a, res.score_b) = 0) as is_sweep,
    -- An upset: the team they backed was rated below its opponent.
    (p.pick = res.winner and pr.glicko is not null and orr.glicko is not null
       and pr.glicko < orr.glicko)                           as is_upset,
    ((p.score_a + p.score_b) = (res.score_a + res.score_b))   as game_count_hit,
    (g.winner is not null and p.pick = g.winner)              as took_game_one,
    (p.pick = res.winner and g.winner is not null
       and g.winner <> res.winner)                            as reverse_sweep,
    c.share,
    stage_weight(p.match_id, r.rules ->> 'scoreMode')         as weight
  from predictions p
  cross join r
  join match_results res on res.match_id = p.match_id
  left join matches m     on m.match_id  = p.match_id
  left join consensus c   on c.match_id  = p.match_id and c.pick = p.pick
  left join game1 g       on g.match_id  = p.match_id
  -- Ratings of the picked team and of its opponent, matched by name.
  left join team_ratings pr  on lower(pr.name)  = lower(p.pick)
  left join team_ratings orr on lower(orr.name) = lower(
        case when lower(p.pick) = lower(coalesce(m.team_a,'')) then m.team_b else m.team_a end)
  where p.league_id = p_league and p.locked
),
per_match as (
  select b.user_id, b.is_correct, b.is_exact, b.scheduled_at, b.match_id,
    round((
        case when rule_on(r.rules,'winner',true) and b.is_correct
             then rule_pts(r.rules,'winner',10) else 0 end
      + case when rule_on(r.rules,'exactScore',true) and b.is_exact
             then rule_pts(r.rules,'exactScore',15) else 0 end
      + case when rule_on(r.rules,'cleanSweep') and b.is_sweep
             then rule_pts(r.rules,'cleanSweep',8) else 0 end
      + case when rule_on(r.rules,'upsetBonus') and b.is_upset
             then rule_pts(r.rules,'upsetBonus',10) else 0 end
      + case when rule_on(r.rules,'gameCountOU') and b.game_count_hit
             then rule_pts(r.rules,'gameCountOU',6) else 0 end
      + case when rule_on(r.rules,'loneWolf') and b.is_correct and b.share <= 0.25
             then rule_pts(r.rules,'loneWolf',5) else 0 end
      + case when rule_on(r.rules,'firstGame') and b.took_game_one
             then rule_pts(r.rules,'firstGame',5) else 0 end
      + case when rule_on(r.rules,'reverseSweep') and b.reverse_sweep
             then rule_pts(r.rules,'reverseSweep',12) else 0 end
      + case when rule_on(r.rules,'negativePoints') and not b.is_correct
             then -rule_pts(r.rules,'negativePoints',5) else 0 end
    ) * b.weight)::int as pts
  from base b cross join r
),
-- Streaks: number the settled picks per user in playing order, then find runs
-- of correct ones. row_number difference is the classic gaps-and-islands trick.
ordered as (
  select user_id, is_correct,
         row_number() over (partition by user_id order by coalesce(scheduled_at, 'epoch'::timestamptz), match_id) as rn
  from per_match
),
runs as (
  select user_id, count(*)::int as run_len
  from (select user_id, is_correct, rn,
               rn - row_number() over (partition by user_id, is_correct
                                       order by rn) as grp
        from ordered) x
  where is_correct
  group by user_id, grp
),
streaks as (
  select user_id, max(run_len) as best_streak,
         -- Points are per EXTRA correct pick in a run, so a lone correct pick
         -- earns nothing and a run of 4 earns three bonuses.
         sum(greatest(run_len - 1, 0))::int as streak_extras
  from runs group by user_id
),
-- A perfect day needs at least two settled picks that day, all correct.
days as (
  select user_id, date_trunc('day', coalesce(scheduled_at, 'epoch'::timestamptz)) as d,
         count(*) as n, count(*) filter (where is_correct) as ok
  from per_match
  where scheduled_at is not null
  group by user_id, date_trunc('day', coalesce(scheduled_at, 'epoch'::timestamptz))
),
perfect_days as (
  select user_id, count(*)::int as n_perfect
  from days where n >= 2 and ok = n group by user_id
),
match_totals as (
  select pm.user_id,
         sum(pm.pts)::int as pts,
         count(*) filter (where pm.is_correct)::int as correct,
         count(*)::int as scored,
         count(*) filter (where pm.is_exact)::int as exact_hits
  from per_match pm group by pm.user_id
),
actual as (
  select
    (select winner from match_results where match_id = 'me-r5m1') as champion,
    (select winner from match_results where match_id = 'me-r4m2') as lb_final_winner,
    (select array_agg(t) from (
        select unnest(array[team_a, team_b]) t from matches where match_id = 'me-r5m1'
     ) x where t is not null and t <> 'TBD')                      as finalists,
    (select array_agg(distinct t) from (
        select unnest(array[team_a, team_b]) t from matches
        where match_id in ('me-r4m1', 'me-r3m1')
     ) x where t is not null and t <> 'TBD')                      as top4,
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
  (coalesce(mt.pts, 0)
   + coalesce(ot.pts, 0)
   + case when rule_on(r.rules,'streakBonus')
          then coalesce(st.streak_extras,0) * rule_pts(r.rules,'streakBonus',5) else 0 end
   + case when rule_on(r.rules,'perfectDay')
          then coalesce(pd.n_perfect,0) * rule_pts(r.rules,'perfectDay',25) else 0 end
  )::int                                           as points,
  coalesce(mt.correct, 0)                          as correct,
  coalesce(mt.scored, 0)                           as scored,
  coalesce(mt.exact_hits, 0)                       as exact_hits,
  coalesce(ot.pts, 0)                              as outcome_points,
  coalesce(st.best_streak, 0)::int                 as best_streak
from league_members m
cross join r
left join match_totals   mt on mt.user_id = m.user_id
left join outcome_totals ot on ot.user_id = m.user_id
left join streaks        st on st.user_id = m.user_id
left join perfect_days   pd on pd.user_id = m.user_id
where m.league_id = p_league
order by
  points desc,
  (case when rule_on(r.rules, 'tbExactHits', true)
        then coalesce(mt.exact_hits, 0) else 0 end) desc,
  (case when rule_on(r.rules, 'tbChampion', true)
        then coalesce(ot.pts, 0) else 0 end) desc,
  coalesce(mt.correct, 0) desc,
  m.username;
$function$;
