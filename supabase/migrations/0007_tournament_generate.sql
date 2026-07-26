-- Bracket / schedule generation.
--
-- Called once by the organiser. Produces every match as a real row, with the
-- winner's onward path already wired, so nothing about the bracket has to be
-- recomputed later.

create or replace function public.tournament_start(p_tournament uuid)
returns int
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  t             tournaments%rowtype;
  n_teams       int;
  size          int;
  rounds        int;
  seed_order    int[];
  ids           uuid[];
  r             int;
  s             int;
  m_count       int;
  cur_id        uuid;
  nxt_id        uuid;
  a_id          uuid;
  b_id          uuid;
  lbl           text;
  bo            int;
  third_id      uuid;
  created       int := 0;
  -- round robin
  arr           uuid[];
  m             int;
  i             int;
  tmp           uuid;
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

  -- Seed by world ranking where we know the team, strongest first; everyone
  -- else keeps their sign-up order behind them. This is why the two best
  -- sides meet in the final rather than in round one.
  with ranked as (
    select tt.id,
           row_number() over (
             order by coalesce(tr.conservative, tr.glicko) desc nulls last,
                      tt.joined_at
           ) as rn
    from tournament_teams tt
    left join team_ratings tr on lower(tr.name) = lower(tt.name)
    where tt.tournament_id = p_tournament
  )
  update tournament_teams tt set seed = ranked.rn
  from ranked where ranked.id = tt.id;

  select array_agg(id order by seed) into ids
  from tournament_teams where tournament_id = p_tournament;

  delete from tournament_matches where tournament_id = p_tournament;

  -- ------------------------------------------------------------------ round robin
  if t.format = 'round_robin' then
    arr := ids;
    m := n_teams;
    if m % 2 = 1 then arr := arr || null::uuid; m := m + 1; end if;  -- phantom = bye
    bo := coalesce((t.series_format ->> 'default')::int, 3);
    for r in 1..(m - 1) loop
      for i in 1..(m / 2) loop
        a_id := arr[i];
        b_id := arr[m + 1 - i];
        if a_id is not null and b_id is not null then
          insert into tournament_matches
            (tournament_id, bracket, round, slot, label, team_a, team_b, best_of, status)
          values (p_tournament, 'main', r, i, 'Round ' || r, a_id, b_id, bo, 'ready');
          created := created + 1;
        end if;
      end loop;
      -- rotate everything except the first entry
      tmp := arr[m];
      for i in reverse m..3 loop arr[i] := arr[i - 1]; end loop;
      arr[2] := tmp;
    end loop;

    update tournaments set status = 'running', started_at = now() where id = p_tournament;
    return created;
  end if;

  -- ------------------------------------------------------------- single elimination
  size := 2;
  while size < n_teams loop size := size * 2; end loop;
  rounds := (ln(size) / ln(2))::int;
  seed_order := bracket_seed_order(size);

  -- Create every match, latest round first, so each earlier match can point
  -- at an existing later one.
  for r in reverse rounds..1 loop
    m_count := size / (2 ^ r)::int;      -- round 1 has size/2, the final has 1
    lbl := case
             when r = rounds     then 'Final'
             when r = rounds - 1 then 'Semi-final'
             when r = rounds - 2 then 'Quarter-final'
             else 'Round ' || r end;
    bo := series_len(t.series_format, r, rounds);
    for s in 1..m_count loop
      insert into tournament_matches
        (tournament_id, bracket, round, slot, label, best_of, status)
      values (p_tournament, 'main', r, s, lbl, bo, 'pending')
      returning id into cur_id;
      created := created + 1;
      if r < rounds then
        select id into nxt_id from tournament_matches
        where tournament_id = p_tournament and bracket = 'main'
          and round = r + 1 and slot = ((s + 1) / 2);
        update tournament_matches
          set next_match_id = nxt_id, next_is_a = (s % 2 = 1)
        where id = cur_id;
      end if;
    end loop;
  end loop;

  -- Optional third-place match, fed by the two semi-final losers.
  if t.third_place and rounds >= 2 then
    insert into tournament_matches
      (tournament_id, bracket, round, slot, label, best_of, status)
    values (p_tournament, 'third_place', rounds, 1, 'Third place',
            series_len(t.series_format, rounds - 1, rounds), 'pending')
    returning id into third_id;
    created := created + 1;
    update tournament_matches set loser_match_id = third_id,
           loser_is_a = (slot = 1)
    where tournament_id = p_tournament and bracket = 'main' and round = rounds - 1;
  end if;

  -- Place the teams into round 1 using the standard seed order.
  for s in 1..(size / 2) loop
    a_id := case when seed_order[2 * s - 1] <= n_teams then ids[seed_order[2 * s - 1]] end;
    b_id := case when seed_order[2 * s]     <= n_teams then ids[seed_order[2 * s]]     end;
    update tournament_matches
      set team_a = a_id, team_b = b_id,
          status = case when a_id is not null and b_id is not null then 'ready' else 'pending' end
    where tournament_id = p_tournament and bracket = 'main' and round = 1 and slot = s;
  end loop;

  update tournaments set status = 'running', started_at = now() where id = p_tournament;

  -- Walk byes forward: a round-1 match with only one team is already won.
  perform tournament_resolve_byes(p_tournament);
  return created;
end $function$;


-- Push through any match that has one team and an empty opposite slot.
-- Runs after generation and after each result, so a bye chain resolves fully.
create or replace function public.tournament_resolve_byes(p_tournament uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  changed boolean := true;
  rec      record;
begin
  while changed loop
    changed := false;
    for rec in
      select * from tournament_matches
      where tournament_id = p_tournament and bracket = 'main'
        and status <> 'done'
        and ((team_a is not null and team_b is null) or (team_a is null and team_b is not null))
        -- Only a genuine bye: no earlier match can still deliver an opponent.
        and not exists (
          select 1 from tournament_matches f
          where f.tournament_id = p_tournament and f.next_match_id = tournament_matches.id
            and f.status <> 'done')
      order by round, slot
    loop
      update tournament_matches
        set status = 'done', winner_id = coalesce(rec.team_a, rec.team_b),
            label = label || ' (bye)', updated_at = now()
      where id = rec.id;
      if rec.next_match_id is not null then
        if rec.next_is_a then
          update tournament_matches set team_a = coalesce(rec.team_a, rec.team_b) where id = rec.next_match_id;
        else
          update tournament_matches set team_b = coalesce(rec.team_a, rec.team_b) where id = rec.next_match_id;
        end if;
        update tournament_matches set status = 'ready'
        where id = rec.next_match_id and team_a is not null and team_b is not null and status = 'pending';
      end if;
      changed := true;
    end loop;
  end loop;
end $function$;

revoke all on function public.tournament_start(uuid) from public;
grant execute on function public.tournament_start(uuid) to authenticated;
grant execute on function public.tournament_resolve_byes(uuid) to authenticated, service_role;
