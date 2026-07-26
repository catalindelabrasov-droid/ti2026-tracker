-- ---------------------------------------------------------------------------
-- Group stage into a playoff bracket.
--
-- This is the shape top-level Dota actually uses — TI, DreamLeague, ESL One
-- all run groups feeding a double elimination — and it is the format that
-- makes an event worth turning up to: everyone gets a guaranteed run of games
-- before anyone can be knocked out.
--
-- Two things here are not obvious and are the reason the file exists:
--
--  * Groups are played Bo2, and 1-1 is a real result. That is how Dota group
--    stages are actually played, and it needs a draw to be representable,
--    which the reporting path refused until now.
--
--  * Seeding the playoff is not "line the qualifiers up by rank". Do that with
--    four groups and each group's two qualifiers land in the same half of the
--    bracket, so they meet in the semi-final having already played in the
--    group. Shifting the runner-up band by half the group count puts every
--    group's pair in opposite halves, which is what the big events do.
-- ---------------------------------------------------------------------------

-- An even series has no clinch, so it can end level. Allow that only where a
-- level result means something — a group table. Nothing routes out of a group
-- match, so a draw can never leave a knockout slot waiting for a winner.
alter table public.tournament_matches drop constraint if exists tm_even_series_ck;
alter table public.tournament_matches add constraint tm_even_series_ck
  check (best_of % 2 = 1 or bracket = 'group');


-- How many groups for a field of n: the largest power of two that still leaves
-- at least four teams in each. Three-team groups are two fixtures and not
-- worth calling a group stage.
create or replace function public.group_count(n_teams int)
returns int
language sql
immutable
as $function$
  select case when n_teams >= 32 then 8
              when n_teams >= 16 then 4
              when n_teams >= 8  then 2
              else 1 end;
$function$;

-- Serpentine draw: 1→A, 2→B, 3→B, 4→A, 5→A, 6→B … Straight allocation would
-- put seeds 1 and 2 in group A and hand group B an easy run; snaking balances
-- the strength of the groups instead of the order of the names.
create or replace function public.snake_group(seed_no int, groups int)
returns int
language sql
immutable
as $function$
  select case when ((seed_no - 1) / groups) % 2 = 0
              then ((seed_no - 1) % groups) + 1
              else groups - ((seed_no - 1) % groups) end;
$function$;


-- ---------------------------------------------------------------------------
-- Group standings.
--
-- p_group null means the whole field, which is how a plain round robin uses
-- this: those teams have no group_no, so they all fall into one table.
--
-- Two points for a win, one for a draw. Not three-one-nought — that is a
-- football judgement, and it would rank two wins and a loss above one win and
-- two draws, which is not how anyone reads a Dota group.
--
-- Tiebreakers: points, then the mini-table among everyone level on points
-- (results between the tied teams only, which is the argument captains
-- actually make), then that mini-table's game difference, then overall game
-- difference, then games won, then seed so the order is total and the cut is
-- never ambiguous.
-- ---------------------------------------------------------------------------
create or replace function public.tournament_group_standings(
  p_tournament uuid, p_group int default null)
returns table (
  pos int, team_id uuid, team_name text, group_no int,
  played int, won int, drawn int, lost int, points int,
  games_won int, games_lost int, game_diff int,
  h2h_points int, h2h_diff int, ppm numeric, seed int)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with squad as (
    select tt.id, tt.name, tt.seed, tt.group_no
      from tournament_teams tt
     where tt.tournament_id = p_tournament
       and (p_group is null or tt.group_no = p_group)
  ),
  sides as (
    -- Every finished match twice, once from each team's point of view, so
    -- nothing downstream has to keep asking which side a team was on.
    -- mgroup is carried along because a match only counts towards a table if
    -- it belongs to the same group: once the playoff starts, those matches sit
    -- in the same tournament with no group, and must not appear in the group
    -- tables. A plain round robin has no group on either, which matches too.
    select m.team_a as tid, m.team_b as oid, m.score_a as gf, m.score_b as ga,
           m.group_no as mgroup
      from tournament_matches m
     where m.tournament_id = p_tournament and m.status = 'done'
       and m.team_a is not null and m.team_b is not null
       and (p_group is null or m.group_no = p_group)
    union all
    select m.team_b, m.team_a, m.score_b, m.score_a, m.group_no
      from tournament_matches m
     where m.tournament_id = p_tournament and m.status = 'done'
       and m.team_a is not null and m.team_b is not null
       and (p_group is null or m.group_no = p_group)
  ),
  base as (
    select s.id, s.name, s.seed, s.group_no,
           count(x.tid)                                          as played,
           count(*) filter (where x.gf > x.ga)                    as won,
           count(*) filter (where x.tid is not null and x.gf = x.ga) as drawn,
           count(*) filter (where x.gf < x.ga)                    as lost,
           coalesce(sum(x.gf), 0)                                 as gw,
           coalesce(sum(x.ga), 0)                                 as gl
      from squad s
      left join sides x on x.tid = s.id and x.mgroup is not distinct from s.group_no
     group by s.id, s.name, s.seed, s.group_no
  ),
  pts as (
    select b.*, (b.won * 2 + b.drawn)::int as points from base b
  ),
  mini as (
    -- The mini-table. Restricting to opponents on the same points is exactly
    -- "among the teams currently tied", and it handles two, three and four way
    -- ties without any extra code. A circular three-way tie comes out level on
    -- mini-points and is separated by mini game difference.
    select a.id as tid,
           sum(case when x.gf > x.ga then 2 when x.gf = x.ga then 1 else 0 end)::int as h2h_points,
           sum(x.gf - x.ga)::int as h2h_diff
      from pts a
      join sides x on x.tid = a.id and x.mgroup is not distinct from a.group_no
      join pts b   on b.id = x.oid
     where b.points = a.points
       and coalesce(b.group_no, 0) = coalesce(a.group_no, 0)
     group by a.id
  )
  select row_number() over (
           partition by coalesce(p.group_no, 0)
           order by p.points desc,
                    coalesce(m.h2h_points, 0) desc,
                    coalesce(m.h2h_diff, 0) desc,
                    (p.gw - p.gl) desc,
                    p.gw desc,
                    p.seed)::int,
         p.id, p.name, p.group_no,
         p.played::int, p.won::int, p.drawn::int, p.lost::int, p.points,
         p.gw::int, p.gl::int, (p.gw - p.gl)::int,
         coalesce(m.h2h_points, 0), coalesce(m.h2h_diff, 0),
         round(p.points::numeric / greatest(p.played, 1), 3),
         p.seed
    from pts p left join mini m on m.tid = p.id
   order by coalesce(p.group_no, 0), 1;
$function$;


-- ---------------------------------------------------------------------------
-- Where each qualifier sits in the playoff bracket.
--
-- Qualifiers arrive in bands: every group winner, then every runner-up, and so
-- on, ordered by group within each band. Dropping that list straight onto
-- seeds 1..q looks right and is wrong twice over — a group's second and third
-- can end up facing each other in round one, and with four or more groups a
-- group's winner and runner-up land in the same half and meet in the semi.
--
-- Neither is fixable with a constant offset, because which seeds share a half
-- depends on the bracket's own shape: in a sixteen-team bracket the first half
-- is seeds 1, 16, 8, 9, 4, 13, 5 and 12, not 1 to 8. So the halves are read
-- off bracket_seed_order and the runner-up band is placed against them.
--
-- Returns, for each qualifier in banded order, the bracket seed it takes.
-- ---------------------------------------------------------------------------
create or replace function public.playoff_seed_map(p_size int, p_groups int, p_qual int)
returns int[]
language plpgsql
immutable
as $function$
declare
  ord    int[] := bracket_seed_order(p_size);
  half   int[] := array_fill(0, array[p_size]);
  seedof int[] := array_fill(0, array[p_qual]);
  taken  boolean[] := array_fill(false, array[p_size]);
  g int := p_groups;
  s int; h int; j int; p int; chosen int; i int;
begin
  for s in 1..(p_size / 2) loop
    h := case when p_size >= 4 and s <= p_size / 4 then 1 else 2 end;
    half[ord[2*s-1]] := h;
    half[ord[2*s]]   := h;
  end loop;

  -- Band one: group winners take the top seeds, strongest group first.
  for j in 1..least(g, p_qual) loop
    seedof[j] := j; taken[j] := true;
  end loop;

  -- Band two: each runner-up wants a seat in the other half from its own
  -- group's winner, and not the seat directly opposite it in round one.
  if p_qual > g then
    for j in 1..least(g, p_qual - g) loop
      chosen := 0;
      for p in (g+1)..p_qual loop
        if not taken[p] and half[p] <> half[j] and (p_size + 1 - p) <> j then
          chosen := p; exit;
        end if;
      end loop;
      if chosen = 0 then                      -- settle for not meeting in round one
        for p in (g+1)..p_qual loop
          if not taken[p] and (p_size + 1 - p) <> j then chosen := p; exit; end if;
        end loop;
      end if;
      if chosen = 0 then                      -- nothing left to be fussy about
        for p in (g+1)..p_qual loop
          if not taken[p] then chosen := p; exit; end if;
        end loop;
      end if;
      seedof[g + j] := chosen; taken[chosen] := true;
    end loop;
  end if;

  -- Third place in a group and below: whatever seats are left, in group order.
  for i in (2*g + 1)..p_qual loop
    for p in 1..p_qual loop
      if not taken[p] then seedof[i] := p; taken[p] := true; exit; end if;
    end loop;
  end loop;

  return seedof;
end $function$;


-- ---------------------------------------------------------------------------
-- Draw the playoff bracket from the final group tables.
-- ---------------------------------------------------------------------------
create or replace function public.tournament_playoffs(p_tournament uuid)
returns int
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  t     tournaments%rowtype;
  k int; g int; q int; size int;
  ids   uuid[]; band uuid[]; smap int[];
  j int;
begin
  select * into t from tournaments where id = p_tournament;
  if coalesce(t.stage, '') <> 'groups' then return 0; end if;
  if exists (select 1 from tournament_matches
              where tournament_id = p_tournament and bracket = 'group' and status <> 'done')
    then return 0; end if;
  if exists (select 1 from tournament_matches
              where tournament_id = p_tournament and bracket <> 'group')
    then return 0; end if;                       -- already drawn

  k := coalesce((t.stage_config ->> 'advance')::int, 2);
  g := coalesce((t.stage_config ->> 'groups')::int, 1);

  -- Groups are ranked by how strong their winner was, on points per match —
  -- raw points would flatter a team from a bigger group that simply played
  -- more fixtures.
  --
  -- The qualifiers in banded order: every group winner, then every runner-up,
  -- ordered by GROUP within each band rather than by how good the team is.
  select array_agg(s.team_id order by (s.pos - 1) * g + r.rn) into band
    from tournament_group_standings(p_tournament, null) s
    join (select z.group_no, z.rn from (
            select x.group_no,
                   row_number() over (order by x.ppm desc, x.game_diff desc, x.seed) as rn
              from tournament_group_standings(p_tournament, null) x where x.pos = 1) z
         ) r on r.group_no = s.group_no
   where s.pos <= k;

  q := coalesce(array_length(band, 1), 0);
  if q < 2 then return 0; end if;

  size := 2; while size < q loop size := size * 2; end loop;
  smap := playoff_seed_map(size, g, q);
  ids  := array_fill(null::uuid, array[size]);
  for j in 1..q loop
    ids[smap[j]] := band[j];
  end loop;

  update tournaments set stage = 'playoffs' where id = p_tournament;
  return tournament_gen_bracket(
           p_tournament, ids,
           coalesce(t.stage_config ->> 'playoff', 'single_elim') = 'double_elim',
           t.third_place,
           coalesce(t.stage_config -> 'playoff_series', t.series_format));
end $function$;


-- ---------------------------------------------------------------------------
-- Reporting, with an even series allowed to end level.
-- ---------------------------------------------------------------------------
create or replace function public.tournament_report(
  p_match uuid, p_score_a int, p_score_b int, p_dota_ids jsonb default '[]'::jsonb)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  m       tournament_matches%rowtype;
  t       tournaments%rowtype;
  cap_a   uuid; cap_b uuid;
  me      uuid := auth.uid();
  need    int;
  is_org  boolean;
begin
  select * into m from tournament_matches where id = p_match;
  if m.id is null then raise exception 'Match not found.'; end if;
  select * into t from tournaments where id = m.tournament_id;
  select captain_id into cap_a from tournament_teams where id = m.team_a;
  select captain_id into cap_b from tournament_teams where id = m.team_b;
  is_org := (t.organiser_id = me);

  if me is null or (me <> coalesce(cap_a,'00000000-0000-0000-0000-000000000000'::uuid)
                and me <> coalesce(cap_b,'00000000-0000-0000-0000-000000000000'::uuid)
                and not is_org) then
    raise exception 'Only the two captains or the organiser can report this match.';
  end if;
  if m.status = 'done' then raise exception 'This match is already finished.'; end if;
  if m.team_a is null or m.team_b is null then raise exception 'This match does not have both teams yet.'; end if;
  if p_score_a < 0 or p_score_b < 0 then raise exception 'Scores cannot be negative.'; end if;

  if m.best_of % 2 = 0 then
    -- Nobody clinches an even series: both games are played whatever happens,
    -- so the only valid report is a full card.
    if p_score_a + p_score_b <> m.best_of then
      raise exception 'A Bo% is reported with all % games played — %.',
        m.best_of, m.best_of,
        case when m.best_of = 2 then '2-0, 1-1 or 0-2' else 'every game' end;
    end if;
  else
    need := m.best_of / 2 + 1;
    if greatest(p_score_a, p_score_b) <> need then
      raise exception 'A Bo% is won with % games.', m.best_of, need;
    end if;
    if p_score_a + p_score_b > m.best_of then
      raise exception 'That is more games than a Bo% can have.', m.best_of;
    end if;
  end if;

  -- Belt and braces alongside the check constraint: a level result must never
  -- sit at the top of a match somebody has to advance out of.
  if p_score_a = p_score_b and (m.next_match_id is not null or m.loser_match_id is not null) then
    raise exception 'This one has to have a winner — somebody advances out of it.';
  end if;

  -- First report parks the score; the opposite captain (or the organiser)
  -- confirming it is what actually settles the match.
  if m.status <> 'reported' then
    update tournament_matches
       set score_a=p_score_a, score_b=p_score_b, dota_matches=p_dota_ids,
           status='reported', reported_by=me, reported_at=now(), updated_at=now()
     where id = p_match;
    if is_org then
      perform tournament_confirm(p_match);       -- the organiser is the referee
      return 'confirmed';
    end if;
    return 'reported';
  end if;

  if m.reported_by = me and not is_org then
    update tournament_matches
       set score_a=p_score_a, score_b=p_score_b, dota_matches=p_dota_ids, updated_at=now()
     where id = p_match;
    return 'updated';
  end if;
  if m.score_a <> p_score_a or m.score_b <> p_score_b then
    raise exception 'That does not match what the other captain reported (% - %). Agree the score, or ask the organiser to settle it.', m.score_a, m.score_b;
  end if;
  perform tournament_confirm(p_match);
  return 'confirmed';
end $function$;


-- ---------------------------------------------------------------------------
-- Wire groups into the stage machine, the champion rule and the start.
-- ---------------------------------------------------------------------------
create or replace function public.tournament_advance_stage(p_tournament uuid)
returns int
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  t        tournaments%rowtype;
  unplayed int; made int := 0;
begin
  select * into t from tournaments where id = p_tournament;
  if t.id is null or t.status <> 'running' then return 0; end if;

  select count(*) into unplayed
    from tournament_matches
   where tournament_id = p_tournament and status <> 'done';
  if unplayed > 0 then return 0; end if;

  if t.format = 'swiss' then
    made := tournament_swiss_round(p_tournament);
    if made > 0 then return made; end if;
    if coalesce(t.stage, 'swiss') = 'swiss' then
      made := tournament_swiss_playoffs(p_tournament);
      if made > 0 then
        update tournaments set stage = 'playoffs' where id = p_tournament;
        return made;
      end if;
    end if;

  elsif t.format = 'groups' then
    made := tournament_playoffs(p_tournament);
    if made > 0 then return made; end if;
  end if;

  update tournaments
     set status = 'finished', finished_at = now(),
         champion_id = tournament_champion(p_tournament)
   where id = p_tournament;
  return 0;
end $function$;


create or replace function public.tournament_champion(p_tournament uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  t   tournaments%rowtype;
  win uuid;
begin
  select * into t from tournaments where id = p_tournament;

  -- A Swiss stage with no playoff is decided on the standings, tiebreakers and
  -- all — there is no final to read a winner off.
  if t.format = 'swiss'
     and not exists (select 1 from tournament_matches
                      where tournament_id = p_tournament and bracket <> 'swiss') then
    select x.team_id into win from tournament_swiss_standings(p_tournament) x
     order by x.rank limit 1;
    return win;
  end if;

  if t.format = 'round_robin'
     or (t.format = 'groups'
         and not exists (select 1 from tournament_matches
                          where tournament_id = p_tournament and bracket <> 'group')) then
    select x.team_id into win from tournament_group_standings(p_tournament, null) x
     order by x.pos, x.ppm desc limit 1;
    return win;
  end if;

  select winner_id into win
    from tournament_matches
   where tournament_id = p_tournament
     and bracket in ('grand_final','main')
     and status = 'done' and winner_id is not null
   order by case bracket when 'grand_final' then 0 else 1 end, round desc
   limit 1;
  return win;
end $function$;


create or replace function public.tournament_start(p_tournament uuid)
returns int
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  t       tournaments%rowtype;
  n_teams int;
  ids     uuid[]; gids uuid[];
  cfg     jsonb;
  g int; k int; gbo int; smallest int; j int;
  created int := 0;
begin
  select * into t from tournaments where id = p_tournament;
  if t.id is null then raise exception 'Tournament not found.'; end if;
  if t.organiser_id <> auth.uid() then
    raise exception 'Only the organiser can start this tournament.';
  end if;
  if t.status <> 'registration' then
    raise exception 'This tournament has already been started.';
  end if;

  select count(*) into n_teams from tournament_teams where tournament_id = p_tournament;
  if n_teams < 2 then raise exception 'At least two teams are needed.'; end if;

  with ranked as (
    select tt.id,
           row_number() over (
             order by coalesce(tr.conservative, tr.glicko) desc nulls last, tt.joined_at) as rn
      from tournament_teams tt
      left join team_ratings tr on lower(tr.name) = lower(tt.name)
     where tt.tournament_id = p_tournament
  )
  update tournament_teams tt set seed = ranked.rn from ranked where ranked.id = tt.id;

  select array_agg(id order by seed) into ids
    from tournament_teams where tournament_id = p_tournament;

  delete from tournament_matches where tournament_id = p_tournament;

  if t.format = 'round_robin' then
    created := tournament_gen_round_robin(
                 p_tournament, ids, coalesce((t.series_format ->> 'default')::int, 3));
    update tournaments set status='running', started_at=now() where id=p_tournament;

  elsif t.format in ('single_elim','double_elim') then
    update tournaments set status='running', started_at=now() where id=p_tournament;
    created := tournament_gen_bracket(p_tournament, ids,
                 t.format = 'double_elim', t.third_place, t.series_format);

  elsif t.format = 'swiss' then
    if n_teams < 4 then
      raise exception 'Swiss needs at least four teams. With fewer, run a round robin — everyone plays everyone anyway.';
    end if;
    if n_teams > 16 then
      raise exception 'Swiss is capped at sixteen teams here. For a bigger field, use a group stage.';
    end if;
    cfg := swiss_defaults(n_teams) || coalesce(t.stage_config, '{}'::jsonb);
    cfg := jsonb_set(cfg, '{rounds}',
             to_jsonb(least(greatest(coalesce((cfg ->> 'rounds')::int, 3), 1),
                            n_teams - 1,
                            greatest(3, n_teams / 2))));
    update tournaments
       set status='running', started_at=now(), stage='swiss', stage_config=cfg
     where id=p_tournament;
    created := tournament_swiss_round(p_tournament);

  elsif t.format = 'groups' then
    if n_teams < 4 then
      raise exception 'A group stage needs at least four teams.';
    end if;
    g := coalesce((t.stage_config ->> 'groups')::int, group_count(n_teams));
    if g > n_teams / 3 then g := greatest(1, n_teams / 3); end if;

    update tournament_teams tt set group_no = snake_group(tt.seed, g)
     where tt.tournament_id = p_tournament;

    -- How many go through is taken from the SMALLEST group, so two groups of
    -- unequal size never send different numbers to the playoff.
    select min(c) into smallest from (
      select count(*) c from tournament_teams
       where tournament_id = p_tournament group by group_no) z;
    k := coalesce((t.stage_config ->> 'advance')::int, greatest(1, smallest / 2));
    if k >= smallest then k := greatest(1, smallest - 1); end if;

    gbo := coalesce((t.stage_config ->> 'group_bo')::int, 2);
    cfg := coalesce(t.stage_config, '{}'::jsonb)
             || jsonb_build_object('groups', g, 'advance', k, 'group_bo', gbo,
                                   'playoff', coalesce(t.stage_config ->> 'playoff',
                                     case when g * k <= 4 then 'single_elim' else 'double_elim' end));
    update tournaments
       set status='running', started_at=now(), stage='groups', stage_config=cfg
     where id=p_tournament;

    for j in 1..g loop
      select array_agg(id order by seed) into gids
        from tournament_teams where tournament_id = p_tournament and group_no = j;
      created := created + tournament_gen_round_robin(p_tournament, gids, gbo, j);
    end loop;

  else
    raise exception 'That format is not one this site can run yet.';
  end if;

  return created;
end $function$;

grant execute on function public.group_count(int)  to anon, authenticated;
grant execute on function public.snake_group(int,int) to anon, authenticated;
grant execute on function public.tournament_group_standings(uuid,int) to anon, authenticated, service_role;
revoke all   on function public.tournament_playoffs(uuid) from public;
grant execute on function public.tournament_playoffs(uuid) to service_role;
revoke execute on function public.tournament_report(uuid,int,int,jsonb) from public;
grant  execute on function public.tournament_report(uuid,int,int,jsonb) to authenticated;
revoke all   on function public.tournament_start(uuid) from public;
grant execute on function public.tournament_start(uuid) to authenticated;
