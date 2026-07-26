-- Double elimination, plus reporting a result and advancing the bracket.
--
-- Double elim is what Dota players expect (it is what TI runs), but the loser
-- routing is the part that goes wrong in most bracket code, so it is written
-- out explicitly here rather than inferred.
--
-- Shape for a bracket of size 2^k:
--   winners rounds 1..k                     (size/2, size/4, … 1 matches)
--   losers  rounds 1..2(k-1), alternating:
--       odd  "minor"  rounds pair losers-bracket survivors against each other
--       even "major"  rounds feed in the team that just dropped from winners
--   grand final                              (1 match)
--   total = 2*size - 1 matches including the grand final.

create or replace function public.tournament_start(p_tournament uuid)
returns int
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  t          tournaments%rowtype;
  n_teams    int; size int; rounds int;
  seed_order int[]; ids uuid[];
  r int; s int; m_count int;
  cur_id uuid; nxt_id uuid; a_id uuid; b_id uuid;
  lbl text; bo int; third_id uuid; gf_id uuid;
  created int := 0;
  arr uuid[]; m int; i int; tmp uuid;
  lb_rounds int; lb_count int; j int;
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

  -- ---------------------------------------------------------------- round robin
  if t.format = 'round_robin' then
    arr := ids; m := n_teams;
    if m % 2 = 1 then arr := arr || null::uuid; m := m + 1; end if;
    bo := coalesce((t.series_format ->> 'default')::int, 3);
    for r in 1..(m - 1) loop
      for i in 1..(m / 2) loop
        a_id := arr[i]; b_id := arr[m + 1 - i];
        if a_id is not null and b_id is not null then
          insert into tournament_matches
            (tournament_id,bracket,round,slot,label,team_a,team_b,best_of,status)
          values (p_tournament,'main',r,i,'Round '||r,a_id,b_id,bo,'ready');
          created := created + 1;
        end if;
      end loop;
      tmp := arr[m];
      for i in reverse m..3 loop arr[i] := arr[i-1]; end loop;
      arr[2] := tmp;
    end loop;
    update tournaments set status='running', started_at=now() where id=p_tournament;
    return created;
  end if;

  size := 2; while size < n_teams loop size := size * 2; end loop;
  rounds := (ln(size)/ln(2))::int;
  seed_order := bracket_seed_order(size);

  -- ------------------------------------------------------- winners / single elim
  for r in reverse rounds..1 loop
    m_count := size / (2 ^ r)::int;
    lbl := case
      when t.format = 'double_elim' then
        case when r = rounds then 'Winners final'
             when r = rounds-1 then 'Winners semi-final'
             else 'Winners round '||r end
      else
        case when r = rounds then 'Final'
             when r = rounds-1 then 'Semi-final'
             when r = rounds-2 then 'Quarter-final'
             else 'Round '||r end
      end;
    bo := series_len(t.series_format, r, rounds);
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

  if t.format <> 'double_elim' then
    if t.third_place and rounds >= 2 then
      insert into tournament_matches (tournament_id,bracket,round,slot,label,best_of,status)
      values (p_tournament,'third_place',rounds,1,'Third place',
              series_len(t.series_format,rounds-1,rounds),'pending') returning id into third_id;
      created := created + 1;
      update tournament_matches set loser_match_id=third_id, loser_is_a=(slot=1)
      where tournament_id=p_tournament and bracket='main' and round=rounds-1;
    end if;
  else
    -- ------------------------------------------------------------- losers bracket
    lb_rounds := 2 * (rounds - 1);
    if lb_rounds >= 1 then
      -- Create losers rounds from the last backwards so links always exist.
      for r in reverse lb_rounds..1 loop
        -- rounds 2j-1 and 2j both hold size/2^(j+1) matches
        j := (r + 1) / 2;
        lb_count := size / (2 ^ (j + 1))::int;
        if lb_count < 1 then lb_count := 1; end if;
        lbl := case when r = lb_rounds then 'Losers final' else 'Losers round '||r end;
        bo := coalesce((t.series_format ->> 'default')::int, 3);
        for s in 1..lb_count loop
          insert into tournament_matches (tournament_id,bracket,round,slot,label,best_of,status)
          values (p_tournament,'losers',r,s,lbl,bo,'pending') returning id into cur_id;
          created := created + 1;
          if r < lb_rounds then
            -- odd (minor) -> even (major) keeps the slot; even -> odd halves it
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

    -- Grand final
    insert into tournament_matches (tournament_id,bracket,round,slot,label,best_of,status)
    values (p_tournament,'grand_final',1,1,'Grand final',
            series_len(t.series_format,rounds,rounds),'pending') returning id into gf_id;
    created := created + 1;
    update tournament_matches set next_match_id=gf_id, next_is_a=true
      where tournament_id=p_tournament and bracket='main' and round=rounds;
    if lb_rounds >= 1 then
      update tournament_matches set next_match_id=gf_id, next_is_a=false
        where tournament_id=p_tournament and bracket='losers' and round=lb_rounds;
    end if;

    -- Where each winners-bracket loser drops to.
    -- Round 1 losers pair up into losers round 1; later rounds feed the
    -- "major" losers round 2*(r-1).
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

  -- Place teams into winners round 1 by seed.
  for s in 1..(size/2) loop
    a_id := case when seed_order[2*s-1] <= n_teams then ids[seed_order[2*s-1]] end;
    b_id := case when seed_order[2*s]   <= n_teams then ids[seed_order[2*s]]   end;
    update tournament_matches
      set team_a=a_id, team_b=b_id,
          status = case when a_id is not null and b_id is not null then 'ready' else 'pending' end
    where tournament_id=p_tournament and bracket='main' and round=1 and slot=s;
  end loop;

  update tournaments set status='running', started_at=now() where id=p_tournament;
  perform tournament_resolve_byes(p_tournament);
  return created;
end $function$;


-- ---------------------------------------------------------------------------
-- Reporting a result.
--
-- Either captain reports; the opponent confirms. The bracket only moves once
-- both agree, so one team cannot advance itself. Dota match ids are stored
-- alongside so the claim can be checked against the real game.
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
  win     uuid;
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

  need := m.best_of / 2 + 1;
  if p_score_a < 0 or p_score_b < 0 then raise exception 'Scores cannot be negative.'; end if;
  if greatest(p_score_a, p_score_b) <> need then
    raise exception 'A Bo% is won with % games.', m.best_of, need;
  end if;
  if p_score_a + p_score_b > m.best_of then
    raise exception 'That is more games than a Bo% can have.', m.best_of;
  end if;

  win := case when p_score_a > p_score_b then m.team_a else m.team_b end;

  -- First report parks the score; the opposite captain (or the organiser)
  -- confirming it is what actually settles the match.
  if m.status <> 'reported' then
    update tournament_matches
      set score_a=p_score_a, score_b=p_score_b, dota_matches=p_dota_ids,
          status='reported', reported_by=me, reported_at=now(), updated_at=now()
    where id = p_match;
    if is_org then
      -- The organiser is the referee: their word settles it immediately.
      perform tournament_confirm(p_match);
      return 'confirmed';
    end if;
    return 'reported';
  end if;

  -- Someone is confirming (or correcting) an existing report.
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


-- Settle a match and move the teams onward.
create or replace function public.tournament_confirm(p_match uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  m tournament_matches%rowtype;
  win uuid; lose uuid;
  remaining int;
begin
  select * into m from tournament_matches where id = p_match;
  win  := case when m.score_a > m.score_b then m.team_a else m.team_b end;
  lose := case when m.score_a > m.score_b then m.team_b else m.team_a end;

  update tournament_matches
    set status='done', winner_id=win, confirmed_by=auth.uid(), updated_at=now()
  where id = p_match;

  if m.next_match_id is not null then
    if m.next_is_a then update tournament_matches set team_a=win where id=m.next_match_id;
    else                update tournament_matches set team_b=win where id=m.next_match_id; end if;
    update tournament_matches set status='ready'
      where id=m.next_match_id and team_a is not null and team_b is not null and status='pending';
  end if;

  if m.loser_match_id is not null then
    if m.loser_is_a then update tournament_matches set team_a=lose where id=m.loser_match_id;
    else                 update tournament_matches set team_b=lose where id=m.loser_match_id; end if;
    update tournament_matches set status='ready'
      where id=m.loser_match_id and team_a is not null and team_b is not null and status='pending';
  end if;

  perform tournament_resolve_byes(m.tournament_id);

  -- Finished when nothing is left to play.
  select count(*) into remaining from tournament_matches
   where tournament_id=m.tournament_id and status <> 'done';
  if remaining = 0 then
    update tournaments set status='finished', finished_at=now(),
           champion_id = (select winner_id from tournament_matches
                          where tournament_id=m.tournament_id
                          order by case bracket when 'grand_final' then 0 when 'main' then 1 else 2 end,
                                   round desc limit 1)
    where id=m.tournament_id;
  end if;
end $function$;

grant execute on function public.tournament_report(uuid,int,int,jsonb) to authenticated;
grant execute on function public.tournament_confirm(uuid) to authenticated, service_role;
