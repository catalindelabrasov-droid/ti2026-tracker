-- A team rename must not change who was right.
--
-- Scoring compared team names with plain string equality: `p.pick = res.winner`.
-- A prediction stores the name as text at the moment it is locked, and the
-- updater later rewrites names in `matches`/`match_results` as Liquipedia
-- settles on a spelling. When "Aurora" became "Aurora Gaming", four already
-- locked and CORRECT picks on gs-r1-m7 silently scored as wrong, costing four
-- of six players 23-43 points each. It compounds: a flipped pick also loses its
-- cleanSweep bonus and splits a streak — one player's best run read 4 when it
-- was really 8.
--
-- Nobody reports this. Nothing errors, nothing looks broken; the leaderboard is
-- just quietly wrong.
--
-- The data was corrected by hand on 14 Aug 2026. This is the durable fix:
-- compare names through a normaliser on BOTH sides, so the spelling in use at
-- any moment stops mattering.

-- ---------------------------------------------------------------- normaliser
-- Mirrors tkey()/canonTeam() in index.html: fold case, drop punctuation, drop
-- the org decoration that different Liquipedia pages add and remove, then apply
-- the handful of aliases that stripping cannot bridge because the two spellings
-- share no stem.
--
-- IMMUTABLE so it can be used in an index later if this ever needs one.
create or replace function public.team_norm(p_name text)
returns text
language sql
immutable
as $$
  select case
           -- Pairs no rule can derive, because the two spellings share no stem.
           -- Matched AFTER the stripping below, so "BetBoom Team" arrives here
           -- as 'betboom' — not 'betboomteam'. Verified by roster, not by
           -- guesswork: the BoomBoys carry in match 8944475901 is Kiritych~,
           -- the first player listed under BetBoom Team.
           when k = 'betboom' then 'boomboys'
           else k
         end
  from (
    select regexp_replace(
             regexp_replace(
               regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9 ]', ' ', 'g'),
               -- org words, as whole words only
               '\y(gaming|esports|esport|e sports|club|team|the|ti|20[0-9]{2})\y', ' ', 'g'),
             '\s+', '', 'g') as k
  ) x;
$$;

comment on function public.team_norm(text) is
  'Canonical form of a team name for comparison. A rename such as Aurora -> Aurora Gaming must not change a scoring verdict.';

-- ------------------------------------------------------- detection, kept live
-- Any locked pick that no longer names either side of its own match means the
-- drift has happened again. Must always be 0.
create or replace view public.prediction_name_drift as
  select p.league_id, p.user_id, p.match_id, p.pick, m.team_a, m.team_b
  from predictions p
  join matches m on m.match_id = p.match_id
  where p.pick is not null
    and team_norm(p.pick) not in (team_norm(m.team_a), team_norm(m.team_b));

comment on view public.prediction_name_drift is
  'Should always be empty. A row means a team was renamed and a locked pick no longer matches either side.';

-- ------------------------------------------------------------ scoring, fixed
-- This is the function EXACTLY as 0005 defines it, with only the team-name
-- comparisons routed through team_norm(). It is produced by substitution on the
-- original text rather than rewritten by hand: a first attempt to retype it
-- introduced a bug in the streak CTEs that Postgres rejected outright. Nothing
-- else about the scoring changes.
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
  select match_id, team_norm(pick) as pick_k,
         count(*)::numeric
           / nullif(sum(count(*)) over (partition by match_id), 0) as share
  from predictions
  where league_id = p_league and locked
  group by match_id, team_norm(pick)
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
    (team_norm(p.pick) = team_norm(res.winner))                                    as is_correct,
    (team_norm(p.pick) = team_norm(res.winner) and p.score_a = res.score_a
       and p.score_b = res.score_b)                          as is_exact,
    -- The beaten side scored nothing.
    (team_norm(p.pick) = team_norm(res.winner) and least(res.score_a, res.score_b) = 0) as is_sweep,
    -- An upset: the team they backed was rated below its opponent.
    (team_norm(p.pick) = team_norm(res.winner) and pr.glicko is not null and orr.glicko is not null
       and pr.glicko < orr.glicko)                           as is_upset,
    ((p.score_a + p.score_b) = (res.score_a + res.score_b))   as game_count_hit,
    (g.winner is not null and team_norm(p.pick) = team_norm(g.winner))              as took_game_one,
    (team_norm(p.pick) = team_norm(res.winner) and g.winner is not null
       and team_norm(g.winner) <> team_norm(res.winner))                            as reverse_sweep,
    c.share,
    stage_weight(p.match_id, r.rules ->> 'scoreMode')         as weight
  from predictions p
  cross join r
  join match_results res on res.match_id = p.match_id
  left join matches m     on m.match_id  = p.match_id
  left join consensus c   on c.match_id  = p.match_id and c.pick_k = team_norm(p.pick)
  left join game1 g       on g.match_id  = p.match_id
  -- Ratings of the picked team and of its opponent, matched by name.
  left join team_ratings pr  on team_norm(pr.name)  = team_norm(p.pick)
  left join team_ratings orr on team_norm(orr.name) = team_norm(
        case when team_norm(p.pick) = team_norm(coalesce(m.team_a,'')) then m.team_b else m.team_a end)
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
    (select team_norm(winner) from match_results where match_id = 'me-r5m1') as champion,
    (select team_norm(winner) from match_results where match_id = 'me-r4m2') as lb_final_winner,
    (select array_agg(team_norm(t)) from (
        select unnest(array[team_a, team_b]) t from matches where match_id = 'me-r5m1'
     ) x where t is not null and t <> 'TBD')                      as finalists,
    (select array_agg(distinct team_norm(t)) from (
        select unnest(array[team_a, team_b]) t from matches
        where match_id in ('me-r4m1', 'me-r3m1')
     ) x where t is not null and t <> 'TBD')                      as top4,
    (select array_agg(distinct team_norm(t)) from (
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
                  and team_norm(o.value #>> '{}') = a.champion
             then rule_pts(r.rules, 'champion', 50) else 0 end
      + case when rule_on(r.rules, 'champFromLB')
                  and a.champion is not null
                  and team_norm(o.value #>> '{}') = a.champion
                  and a.champion = a.lb_final_winner
             then rule_pts(r.rules, 'champFromLB', 20) else 0 end)
      when 'grandFinalists' then
        case when rule_on(r.rules, 'grandFinalists', true) and a.finalists is not null
             then rule_pts(r.rules, 'grandFinalists', 25)
                  * (select count(*) from jsonb_array_elements_text(o.value) e(t)
                     where team_norm(e.t) = any(a.finalists))::int
             else 0 end
      when 'topFour' then
        case when rule_on(r.rules, 'topFour', true) and a.top4 is not null
             then rule_pts(r.rules, 'topFour', 20)
                  * (select count(*) from jsonb_array_elements_text(o.value) e(t)
                     where team_norm(e.t) = any(a.top4))::int
             else 0 end
      when 'topEight' then
        case when rule_on(r.rules, 'topEight') and a.top8 is not null
             then rule_pts(r.rules, 'topEight', 10)
                  * (select count(*) from jsonb_array_elements_text(o.value) e(t)
                     where team_norm(e.t) = any(a.top8))::int
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
;
