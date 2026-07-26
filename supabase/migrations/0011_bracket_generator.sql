-- ---------------------------------------------------------------------------
-- Pull bracket generation out of tournament_start.
--
-- Nothing about how a bracket is built changes here. The point is that a
-- bracket is no longer only ever built at the start from the whole field: a
-- group stage has to build one later, from the teams that qualified. So the
-- generator becomes a function that takes an ordered list of teams and wires
-- up a bracket for them, and tournament_start becomes a dispatcher that
-- decides which shape of tournament to lay out.
--
-- Existing formats must come out byte-identical in behaviour; the bracket
-- completion test is the check on that.
-- ---------------------------------------------------------------------------

-- Build a bracket for p_ids, in order — p_ids[1] is the top seed. Handles both
-- single and double elimination, fills byes when the count is not a power of
-- two, and returns the number of matches created.
create or replace function public.tournament_gen_bracket(
  p_tournament uuid,
  p_ids        uuid[],
  p_double     boolean,
  p_third      boolean,
  p_fmt        jsonb)
returns int
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  n_teams int := coalesce(array_length(p_ids, 1), 0);
  size int; rounds int; seed_order int[];
  r int; s int; m_count int;
  cur_id uuid; nxt_id uuid; a_id uuid; b_id uuid;
  lbl text; bo int; third_id uuid; gf_id uuid;
  lb_rounds int; lb_count int; j int;
  created int := 0;
begin
  if n_teams < 2 then raise exception 'At least two teams are needed.'; end if;

  size := 2; while size < n_teams loop size := size * 2; end loop;
  rounds := (ln(size)/ln(2))::int;
  seed_order := bracket_seed_order(size);

  -- Winners bracket, built from the final backwards so each earlier match has
  -- an existing later one to point at.
  for r in reverse rounds..1 loop
    m_count := size / (2 ^ r)::int;
    lbl := case
      when p_double then
        case when r = rounds then 'Winners final'
             when r = rounds-1 then 'Winners semi-final'
             else 'Winners round '||r end
      else
        case when r = rounds then 'Final'
             when r = rounds-1 then 'Semi-final'
             when r = rounds-2 then 'Quarter-final'
             else 'Round '||r end
      end;
    bo := series_len(p_fmt, r, rounds);
    for s in 1..m_count loop
      insert into tournament_matches (tournament_id,bracket,round,slot,label,best_of,status)
      values (p_tournament,'main',r,s,lbl,bo,'pending') returning id into cur_id;
      created := created + 1;
      if r < rounds then
        select id into nxt_id from tournament_matches
         where tournament_id=p_tournament and bracket='main' and round=r+1 and slot=((s+1)/2);
        update tournament_matches set next_match_id=nxt_id, next_is_a=(s%2=1) where id=cur_id;
      end if;
    end loop;
  end loop;

  if not p_double then
    if p_third and rounds >= 2 then
      insert into tournament_matches (tournament_id,bracket,round,slot,label,best_of,status)
      values (p_tournament,'third_place',rounds,1,'Third place',
              series_len(p_fmt,rounds-1,rounds),'pending') returning id into third_id;
      created := created + 1;
      update tournament_matches set loser_match_id=third_id, loser_is_a=(slot=1)
       where tournament_id=p_tournament and bracket='main' and round=rounds-1;
    end if;
  else
    -- Losers bracket. Odd "minor" rounds pair survivors against each other;
    -- even "major" rounds feed in whoever just dropped out of the winners.
    lb_rounds := 2 * (rounds - 1);
    if lb_rounds >= 1 then
      for r in reverse lb_rounds..1 loop
        j := (r + 1) / 2;
        lb_count := size / (2 ^ (j + 1))::int;
        if lb_count < 1 then lb_count := 1; end if;
        lbl := case when r = lb_rounds then 'Losers final' else 'Losers round '||r end;
        bo := coalesce((p_fmt ->> 'default')::int, 3);
        for s in 1..lb_count loop
          insert into tournament_matches (tournament_id,bracket,round,slot,label,best_of,status)
          values (p_tournament,'losers',r,s,lbl,bo,'pending') returning id into cur_id;
          created := created + 1;
          if r < lb_rounds then
            select id into nxt_id from tournament_matches
             where tournament_id=p_tournament and bracket='losers' and round=r+1
               and slot = case when r % 2 = 1 then s else ((s+1)/2) end;
            update tournament_matches
               set next_match_id=nxt_id,
                   next_is_a = case when r % 2 = 1 then true else (s % 2 = 1) end
             where id=cur_id;
          end if;
        end loop;
      end loop;
    end if;

    insert into tournament_matches (tournament_id,bracket,round,slot,label,best_of,status)
    values (p_tournament,'grand_final',1,1,'Grand final',
            series_len(p_fmt,rounds,rounds),'pending') returning id into gf_id;
    created := created + 1;
    update tournament_matches set next_match_id=gf_id, next_is_a=true
     where tournament_id=p_tournament and bracket='main' and round=rounds;
    if lb_rounds >= 1 then
      update tournament_matches set next_match_id=gf_id, next_is_a=false
       where tournament_id=p_tournament and bracket='losers' and round=lb_rounds;
    end if;

    -- Where each winners-bracket loser drops to. Round 1 losers pair up into
    -- losers round 1; later rounds feed the major round 2*(r-1).
    for r in 1..rounds loop
      if r = 1 and lb_rounds >= 1 then
        update tournament_matches m2
           set loser_match_id = (select id from tournament_matches x
                                  where x.tournament_id=p_tournament and x.bracket='losers'
                                    and x.round=1 and x.slot=((m2.slot+1)/2)),
               loser_is_a = (m2.slot % 2 = 1)
         where m2.tournament_id=p_tournament and m2.bracket='main' and m2.round=1;
      elsif r > 1 and (2*(r-1)) <= lb_rounds then
        update tournament_matches m2
           set loser_match_id = (select id from tournament_matches x
                                  where x.tournament_id=p_tournament and x.bracket='losers'
                                    and x.round=2*(r-1) and x.slot=m2.slot),
               loser_is_a = false
         where m2.tournament_id=p_tournament and m2.bracket='main' and m2.round=r;
      end if;
    end loop;
  end if;

  -- Place the teams into winners round 1 by seed.
  for s in 1..(size/2) loop
    a_id := case when seed_order[2*s-1] <= n_teams then p_ids[seed_order[2*s-1]] end;
    b_id := case when seed_order[2*s]   <= n_teams then p_ids[seed_order[2*s]]   end;
    update tournament_matches
       set team_a=a_id, team_b=b_id,
           status = case when a_id is not null and b_id is not null then 'ready' else 'pending' end
     where tournament_id=p_tournament and bracket='main' and round=1 and slot=s;
  end loop;

  perform tournament_resolve_byes(p_tournament);
  return created;
end $function$;


-- Everyone plays everyone, by the circle method: fix the first team and rotate
-- the rest, which produces a schedule where nobody sits out twice in a row.
create or replace function public.tournament_gen_round_robin(
  p_tournament uuid, p_ids uuid[], p_bo int, p_group int default null)
returns int
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  arr uuid[] := p_ids;
  m int := coalesce(array_length(p_ids,1),0);
  r int; i int; a_id uuid; b_id uuid; tmp uuid;
  created int := 0; slot_n int;
begin
  if m < 2 then return 0; end if;
  if m % 2 = 1 then arr := arr || null::uuid; m := m + 1; end if;

  for r in 1..(m - 1) loop
    slot_n := 0;
    for i in 1..(m / 2) loop
      a_id := arr[i]; b_id := arr[m + 1 - i];
      if a_id is not null and b_id is not null then
        slot_n := slot_n + 1;
        insert into tournament_matches
          (tournament_id,bracket,round,slot,label,team_a,team_b,best_of,status,group_no)
        values (p_tournament,
                case when p_group is null then 'main' else 'group' end,
                r, slot_n,
                case when p_group is null then 'Round '||r
                     else 'Group '||chr(64+p_group)||' · round '||r end,
                a_id, b_id, p_bo, 'ready', p_group);
        created := created + 1;
      end if;
    end loop;
    tmp := arr[m];
    for i in reverse m..3 loop arr[i] := arr[i-1]; end loop;
    arr[2] := tmp;
  end loop;
  return created;
end $function$;


-- ---------------------------------------------------------------------------
-- tournament_start is now a dispatcher: validate, seed, lay out stage one.
-- Everything after stage one is tournament_advance_stage's job.
-- ---------------------------------------------------------------------------
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

  -- Seed by world ranking where we know a team, and by the order they signed
  -- up where we do not.
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

  else
    -- Swiss and group stages are laid out by their own migrations, which
    -- replace this function's else-branch. Reaching here means the format
    -- passed the check constraint but nothing knows how to run it.
    raise exception 'That format is not one this site can run yet.';
  end if;

  return created;
end $function$;

revoke all   on function public.tournament_gen_bracket(uuid,uuid[],boolean,boolean,jsonb) from public;
revoke all   on function public.tournament_gen_round_robin(uuid,uuid[],int,int) from public;
grant execute on function public.tournament_gen_bracket(uuid,uuid[],boolean,boolean,jsonb) to service_role;
grant execute on function public.tournament_gen_round_robin(uuid,uuid[],int,int) to service_role;
revoke all   on function public.tournament_start(uuid) from public;
grant execute on function public.tournament_start(uuid) to authenticated;
revoke execute on function public.tournament_advance_stage(uuid) from public;
grant  execute on function public.tournament_advance_stage(uuid) to authenticated, service_role;
revoke execute on function public.tournament_champion(uuid) from public;
grant  execute on function public.tournament_champion(uuid) to authenticated, service_role;
