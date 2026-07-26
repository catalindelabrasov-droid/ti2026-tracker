-- ---------------------------------------------------------------------------
-- The Swiss system.
--
-- Everyone plays every round, always against a team on the same record, and
-- nobody plays the same opponent twice. It is the format for a field that is
-- too big for a round robin and too unforgiving for straight elimination:
-- a fixed number of nights, every team guaranteed the same number of games,
-- and nobody knocked out by one bad Bo1.
--
-- The round count is not ceil(log2 N) — that answers a different question (how
-- long until one team is left undefeated). A Swiss stage here is a qualifier:
-- it splits the field into through and out. For that the governing identity is
--
--     rounds = advance_wins + eliminate_losses - 1
--
-- because a team's fate is a race between wins and losses, and everyone's is
-- settled by that round at the latest. With both set to 2, three rounds cut
-- any field almost exactly in half. With both set to 3, five rounds do it with
-- much better separation — that is the CS Major shape.
-- ---------------------------------------------------------------------------

-- Sensible settings for a field of n. rounds is capped at n-1 afterwards,
-- because beyond that everyone has already played everyone.
create or replace function public.swiss_defaults(n_teams int)
returns jsonb
language sql
immutable
as $function$
  select jsonb_build_object('playoff','single_elim') || case
    when n_teams <= 5  then jsonb_build_object(
      'rounds', least(greatest(n_teams - 1, 1), 3), 'mode', 'full', 'qualify', 2)
    when n_teams <= 7  then jsonb_build_object(
      'rounds', 3, 'mode', 'full', 'qualify', 4)
    when n_teams <= 12 then jsonb_build_object(
      'rounds', 3, 'mode', 'cut', 'advance_wins', 2, 'eliminate_losses', 2)
    else                    jsonb_build_object(
      'rounds', 5, 'mode', 'cut', 'advance_wins', 3, 'eliminate_losses', 3)
  end;
$function$;


-- ---------------------------------------------------------------------------
-- The pairer.
--
-- A depth-first search over rematch-free pairings, with the candidate order
-- chosen so that the FIRST solution found is the textbook pairing whenever the
-- textbook pairing is legal. Backtracking only ever engages when repeats block
-- it, which is exactly when a tournament director would step in by hand.
--
-- Why a search rather than one greedy pass: a greedy pass can pair happily for
-- five matches and then discover the last two teams have already played each
-- other. It has no way back. The search simply retracts the previous pairing
-- and slides one seat along.
--
-- p_teams is the pool in rank order, p_wins the matching win counts, p_played
-- the fixtures already played as 'smaller-uuid|larger-uuid'. Returns a flat
-- array [a1,b1,a2,b2,…], or null when this branch cannot be completed.
-- ---------------------------------------------------------------------------
create or replace function public.swiss_pair(
  p_teams uuid[], p_wins int[], p_played text[], p_relaxed boolean, p_budget int)
returns table (pairs uuid[], budget int)
language plpgsql
as $function$
declare
  n int; bsize int; j0 int; d int; k int; i int;
  a uuid; b uuid; key text;
  cand int[] := '{}';
  sub uuid[]; subw int[]; sub_pairs uuid[];
  bud int := p_budget;
begin
  n := coalesce(array_length(p_teams, 1), 0);
  if n = 0 then pairs := '{}'; budget := bud; return next; return; end if;

  -- A node budget rather than a proof of speed. Exhausting it is reported as
  -- "no rematch-free pairing exists", which the caller handles.
  bud := bud - 1;
  if bud <= 0 then pairs := null; budget := 0; return next; return; end if;

  a := p_teams[1];

  -- The head's pairing bracket: everyone on the same record.
  bsize := 0;
  while bsize < n and p_wins[bsize + 1] = p_wins[1] loop bsize := bsize + 1; end loop;
  -- A head alone on its record has floated down from the group above, so it
  -- joins the group below rather than sitting out.
  if bsize = 1 and n > 1 then
    while bsize < n and p_wins[bsize + 1] = p_wins[2] loop bsize := bsize + 1; end loop;
  end if;
  -- An odd bracket sends its bottom team down to the next one. Float-downs are
  -- therefore not a special case; they fall out of the bracket definition.
  if bsize % 2 = 1 then bsize := bsize - 1; end if;
  if bsize < 2 then bsize := least(2, n); end if;

  -- The ideal opponent is the top of the bottom half — the standard fold, so
  -- an eight-team bracket gives 1v5, 2v6, 3v7, 4v8 with no bookkeeping.
  j0 := 1 + bsize / 2;
  cand := array[j0];
  for d in 1..bsize loop
    if j0 + d <= bsize then cand := cand || (j0 + d); end if;
    if j0 - d >= 2     then cand := cand || (j0 - d); end if;
  end loop;
  -- Last resort: float the head itself past its own group. This is what makes
  -- the search complete rather than merely clever.
  for i in (bsize + 1)..n loop cand := cand || i; end loop;

  foreach k in array cand loop
    b := p_teams[k];
    key := least(a::text, b::text) || '|' || greatest(a::text, b::text);
    if not p_relaxed and key = any(p_played) then continue; end if;

    sub  := p_teams[2:k-1] || p_teams[k+1:n];
    subw := p_wins [2:k-1] || p_wins [k+1:n];
    select s.pairs, s.budget into sub_pairs, bud
      from swiss_pair(sub, subw, p_played, p_relaxed, bud) s;

    if sub_pairs is not null then
      pairs := array[a, b] || sub_pairs; budget := bud; return next; return;
    end if;
    exit when bud <= 0;
  end loop;

  pairs := null; budget := bud; return next;
end $function$;


-- ---------------------------------------------------------------------------
-- Standings.
--
-- Computed from the match rows every time, so there is nothing to keep in sync
-- and no way for the table people read to disagree with the pairings they get.
--
-- Tiebreakers, in order:
--   1. match wins, with losses ascending as its inseparable companion — teams
--      that clinched early have played fewer rounds, so 2-0 and 2-1 must not
--      sort level;
--   2. head-to-head inside the tie group — the only argument a captain will
--      actually accept, and in a short Swiss the only one with real evidence
--      behind it. Three teams in a cycle come out 1-1-1 and fall through
--      harmlessly;
--   3. opponents' win rate — strength of schedule, as a rate rather than a sum
--      because teams that stopped playing have frozen records and a raw
--      Buchholz sum would reward you for having faced teams who played on;
--   4. game difference;
--   5. seed, the deterministic backstop so the order is total and does not
--      shuffle between two renders.
--
-- The order is fixed rather than configurable on purpose: an organiser-ordered
-- list would mean building the ORDER BY with string concatenation inside a
-- security definer function, which is an injection surface for the sake of a
-- knob nobody asked for.
-- ---------------------------------------------------------------------------
create or replace function public.tournament_swiss_standings(p_tournament uuid)
returns table (
  team_id uuid, name text, seed int, rank int,
  played int, wins int, losses int, byes int,
  games_for int, games_against int, game_diff int,
  omw numeric, h2h int, state text, opponents uuid[])
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  cfg  jsonb;
  mode text; adv int; elim int;
begin
  select stage_config into cfg from tournaments where id = p_tournament;
  mode := coalesce(cfg ->> 'mode', 'cut');
  adv  := coalesce((cfg ->> 'advance_wins')::int, 99);
  elim := coalesce((cfg ->> 'eliminate_losses')::int, 99);

  return query
  with sides as (
    -- One row per team per match played, from both sides.
    select m.team_a as tid, m.team_b as opp,
           (m.winner_id = m.team_a) as won,
           m.score_a as gf, m.score_b as ga, (m.team_b is null) as bye
      from tournament_matches m
     where m.tournament_id = p_tournament and m.bracket = 'swiss'
       and m.status = 'done' and m.team_a is not null
    union all
    select m.team_b, m.team_a, (m.winner_id = m.team_b), m.score_b, m.score_a, false
      from tournament_matches m
     where m.tournament_id = p_tournament and m.bracket = 'swiss'
       and m.status = 'done' and m.team_b is not null
  ),
  rec as (
    select tt.id as tid, tt.name, tt.seed,
           count(*) filter (where s.tid is not null)              as played,
           count(*) filter (where s.won)                          as wins,
           count(*) filter (where s.tid is not null and not s.won) as losses,
           count(*) filter (where s.bye)                          as byes,
           coalesce(sum(s.gf), 0)                                 as gf,
           coalesce(sum(s.ga), 0)                                 as ga,
           coalesce(array_agg(s.opp) filter (where s.opp is not null), '{}') as opps
      from tournament_teams tt
      left join sides s on s.tid = tt.id
     where tt.tournament_id = p_tournament
     group by tt.id, tt.name, tt.seed
  ),
  sos as (
    -- Strength of schedule. A bye contributes nothing: it is handed to the
    -- weakest team available, so a depressed number is roughly the truth.
    select s.tid,
           avg(case when s.bye then 0.0
                    else r.wins::numeric / greatest(r.played, 1) end) as omw
      from sides s left join rec r on r.tid = s.opp
     group by s.tid
  ),
  grp as (
    select r.*, coalesce(o.omw, 0)::numeric(6,4) as omw,
           dense_rank() over (order by r.wins desc, r.losses asc) as tie
      from rec r left join sos o on o.tid = r.tid
  ),
  h2h as (
    select g.tid,
           (select count(*) from sides s join grp g2 on g2.tid = s.opp
             where s.tid = g.tid and s.won and g2.tie = g.tie)::int as h2h_wins
      from grp g
  )
  select g.tid, g.name, g.seed,
         row_number() over (order by g.wins desc, g.losses asc, h.h2h_wins desc,
                                     g.omw desc, (g.gf - g.ga) desc, g.seed)::int,
         g.played::int, g.wins::int, g.losses::int, g.byes::int,
         g.gf::int, g.ga::int, (g.gf - g.ga)::int,
         g.omw, h.h2h_wins,
         case when mode = 'cut' and g.wins   >= adv  then 'advanced'
              when mode = 'cut' and g.losses >= elim then 'eliminated'
              else 'alive' end,
         g.opps
    from grp g join h2h h on h.tid = g.tid
   order by 4;
end $function$;


-- ---------------------------------------------------------------------------
-- Generate the next Swiss round. Returns how many matches it created; 0 means
-- nothing was owed, which is the normal answer for most confirmations.
--
-- The caller holds a per-tournament advisory lock, so two captains settling
-- the last two matches of a round cannot both decide they are the one who
-- should draw the next one.
-- ---------------------------------------------------------------------------
create or replace function public.tournament_swiss_round(p_tournament uuid)
returns int
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  t        tournaments%rowtype;
  cur_r    int; total_r int; mode text; adv int; elim int;
  pool_ids uuid[]; pool_w int[]; pool_l int[];
  played   text[];
  bye_id   uuid; pos int;
  res      record; relaxed boolean := false;
  i int; s int; created int := 0;
  a uuid; b uuid; aw int; al int; bw int; bl int;
  is_dec boolean; stakes text; bo int;
begin
  select * into t from tournaments where id = p_tournament;
  if t.format <> 'swiss' or t.status <> 'running' then return 0; end if;

  mode    := coalesce(t.stage_config ->> 'mode', 'cut');
  adv     := coalesce((t.stage_config ->> 'advance_wins')::int, 99);
  elim    := coalesce((t.stage_config ->> 'eliminate_losses')::int, 99);
  total_r := coalesce((t.stage_config ->> 'rounds')::int, 3);

  select coalesce(max(round), 0) into cur_r
    from tournament_matches where tournament_id = p_tournament and bracket = 'swiss';

  if cur_r >= total_r then return 0; end if;               -- the stage is over
  if cur_r > 0 and exists (
       select 1 from tournament_matches
        where tournament_id = p_tournament and bracket = 'swiss'
          and round = cur_r and status <> 'done') then
    return 0;                                              -- still being played
  end if;
  if exists (select 1 from tournament_matches
              where tournament_id = p_tournament and bracket = 'swiss'
                and round = cur_r + 1) then
    return 0;                                              -- somebody beat us to it
  end if;

  -- Whoever is still alive, in standings order. In cut mode a team that has
  -- clinched or been knocked out plays no more Swiss: a dead rubber in an
  -- amateur cup is a no-show waiting to happen, and one no-show stalls the
  -- whole round.
  select array_agg(x.team_id order by x.rank),
         array_agg(x.wins    order by x.rank),
         array_agg(x.losses  order by x.rank)
    into pool_ids, pool_w, pool_l
    from tournament_swiss_standings(p_tournament) x
   where mode = 'full' or x.state = 'alive';

  if coalesce(array_length(pool_ids, 1), 0) < 2 then return 0; end if;

  -- An odd pool needs a bye. It goes to the lowest-ranked team that has not
  -- had one; if everyone has, to whoever has had fewest. That second clause is
  -- what makes the rule total — it cannot loop and it cannot fail.
  if array_length(pool_ids, 1) % 2 = 1 then
    select x.team_id into bye_id
      from tournament_swiss_standings(p_tournament) x
     where (mode = 'full' or x.state = 'alive')
     order by x.byes asc, x.rank desc
     limit 1;
    pos := array_position(pool_ids, bye_id);
    pool_ids := pool_ids[1:pos-1] || pool_ids[pos+1:array_length(pool_ids,1)];
    pool_w   := pool_w  [1:pos-1] || pool_w  [pos+1:array_length(pool_w,1)];
    pool_l   := pool_l  [1:pos-1] || pool_l  [pos+1:array_length(pool_l,1)];
  end if;

  select coalesce(array_agg(least(m.team_a::text, m.team_b::text) || '|' ||
                            greatest(m.team_a::text, m.team_b::text)), '{}')
    into played
    from tournament_matches m
   where m.tournament_id = p_tournament and m.bracket = 'swiss'
     and m.team_a is not null and m.team_b is not null;

  if coalesce(array_length(pool_ids, 1), 0) >= 2 then
    select * into res from swiss_pair(pool_ids, pool_w, played, false, 20000);
    if res.pairs is null then
      -- No rematch-free pairing exists. Rather than refuse to run the round,
      -- repeat the least-bad fixture and say so plainly in the UI.
      relaxed := true;
      select * into res from swiss_pair(pool_ids, pool_w, played, true, 20000);
    end if;
    if res.pairs is null then
      raise exception 'Round % could not be drawn. Ask the organiser to finish the stage here.', cur_r + 1;
    end if;

    s := 0;
    for i in 1..(array_length(res.pairs, 1) / 2) loop
      a := res.pairs[2*i-1]; b := res.pairs[2*i];
      aw := pool_w[array_position(pool_ids, a)]; al := pool_l[array_position(pool_ids, a)];
      bw := pool_w[array_position(pool_ids, b)]; bl := pool_l[array_position(pool_ids, b)];

      -- A match is a decider if it settles either team's tournament. You
      -- cannot ask one side to play a single game for their life while the
      -- other treats it as a warm-up, so one side is enough.
      if mode = 'cut' then
        is_dec := (aw = adv - 1 or bw = adv - 1 or al = elim - 1 or bl = elim - 1);
        stakes := case
          when (aw = adv-1 or bw = adv-1) and (al = elim-1 or bl = elim-1) then 'both'
          when (aw = adv-1 or bw = adv-1) then 'advance'
          when (al = elim-1 or bl = elim-1) then 'eliminate' end;
      else
        is_dec := (cur_r + 1 = total_r); stakes := null;
      end if;
      bo := coalesce(case when is_dec then (t.series_format ->> 'decider')::int end,
                     (t.series_format ->> 'default')::int, 1);

      s := s + 1;
      insert into tournament_matches
        (tournament_id, bracket, round, slot, label, team_a, team_b, best_of, status, meta)
      values (p_tournament, 'swiss', cur_r + 1, s,
              -- The label names the ROUND and is read as a column heading, so
              -- it has to be identical for every match in the round.
              'Round ' || (cur_r + 1), a, b, bo, 'ready',
              jsonb_build_object('record', aw || '-' || al, 'decider', is_dec,
                                 'stakes', stakes, 'rematch', relaxed,
                                 'float', (aw <> bw)));
      created := created + 1;
    end loop;
  else
    s := 0;
  end if;

  -- The bye is a real match row, finished, with one empty side — the shape the
  -- bracket renderer already understands. It counts as a win.
  if bye_id is not null then
    insert into tournament_matches
      (tournament_id, bracket, round, slot, label, team_a, team_b, best_of,
       status, score_a, score_b, winner_id, meta)
    values (p_tournament, 'swiss', cur_r + 1, s + 1, 'Round ' || (cur_r + 1),
            bye_id, null, 1, 'done', 1, 0, bye_id, '{"bye":true}'::jsonb);
    created := created + 1;
  end if;

  return created;
end $function$;


-- The bracket the Swiss qualifiers go into.
create or replace function public.tournament_swiss_playoffs(p_tournament uuid)
returns int
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  t     tournaments%rowtype;
  mode  text; po text; qn int;
  ids   uuid[];
begin
  select * into t from tournaments where id = p_tournament;
  po   := coalesce(t.stage_config ->> 'playoff', 'none');
  if po = 'none' then return 0; end if;
  mode := coalesce(t.stage_config ->> 'mode', 'cut');
  qn   := coalesce((t.stage_config ->> 'qualify')::int, 4);

  if mode = 'cut' then
    select array_agg(x.team_id order by x.rank) into ids
      from tournament_swiss_standings(p_tournament) x where x.state = 'advanced';
  else
    select array_agg(x.team_id order by x.rank) into ids
      from (select * from tournament_swiss_standings(p_tournament) order by rank limit qn) x;
  end if;

  if coalesce(array_length(ids, 1), 0) < 2 then return 0; end if;
  return tournament_gen_bracket(p_tournament, ids, po = 'double_elim',
                                t.third_place, t.series_format);
end $function$;


-- ---------------------------------------------------------------------------
-- Wire Swiss into the stage machine and the champion rule.
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

  if t.format = 'round_robin' then
    select x.team_id into win from (
      select tt.id as team_id,
             count(*) filter (where m.winner_id = tt.id) as wins,
             coalesce(sum(case when m.team_a = tt.id then m.score_a - m.score_b
                               when m.team_b = tt.id then m.score_b - m.score_a end), 0) as diff,
             tt.seed
        from tournament_teams tt
        left join tournament_matches m
               on m.tournament_id = tt.tournament_id
              and m.status = 'done'
              and (m.team_a = tt.id or m.team_b = tt.id)
       where tt.tournament_id = p_tournament
       group by tt.id, tt.seed
       order by wins desc, diff desc, tt.seed
       limit 1) x;
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


-- tournament_start gains the Swiss branch. Round one needs no special case:
-- every team is 0-0, so the whole field is one bracket and the fold produces
-- top half against bottom half by itself.
create or replace function public.tournament_start(p_tournament uuid)
returns int
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  t       tournaments%rowtype;
  n_teams int;
  ids     uuid[];
  cfg     jsonb;
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
    -- Anything the organiser did not choose is filled in from the defaults for
    -- this field size.
    --
    -- The round count is then capped at about half the field. The hard limit
    -- is n-1 rounds — beyond that everyone has played everyone — but the real
    -- limit is lower, and it is worth being honest about why. Choosing each
    -- round's pairings optimally is still a greedy choice ACROSS rounds: it is
    -- possible to reach a point where every remaining fixture has already been
    -- played even though a complete schedule existed from the start. Measured
    -- on this implementation, 6, 8 and 12 teams survive a full n-1 rounds, and
    -- 10 teams does not. Half the field keeps the unplayed graph dense enough
    -- that it does not arise, and anyone who wants everyone to play everyone
    -- wants a round robin, which this site already runs.
    cfg := swiss_defaults(n_teams) || coalesce(t.stage_config, '{}'::jsonb);
    cfg := jsonb_set(cfg, '{rounds}',
             to_jsonb(least(greatest(coalesce((cfg ->> 'rounds')::int, 3), 1),
                            n_teams - 1,
                            greatest(3, n_teams / 2))));
    update tournaments
       set status='running', started_at=now(), stage='swiss', stage_config=cfg
     where id=p_tournament;
    created := tournament_swiss_round(p_tournament);

  else
    raise exception 'That format is not one this site can run yet.';
  end if;

  return created;
end $function$;

revoke all   on function public.swiss_pair(uuid[],int[],text[],boolean,int) from public;
revoke all   on function public.tournament_swiss_round(uuid) from public;
revoke all   on function public.tournament_swiss_playoffs(uuid) from public;
grant execute on function public.swiss_pair(uuid[],int[],text[],boolean,int) to service_role;
grant execute on function public.tournament_swiss_round(uuid) to service_role;
grant execute on function public.tournament_swiss_playoffs(uuid) to service_role;
grant execute on function public.swiss_defaults(int) to anon, authenticated;
grant execute on function public.tournament_swiss_standings(uuid) to anon, authenticated, service_role;
revoke all   on function public.tournament_start(uuid) from public;
grant execute on function public.tournament_start(uuid) to authenticated;
