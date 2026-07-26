drop table if exists _tt_out;
create temp table _tt_out (n serial, line text);

do $t$
declare
  org uuid := '6e538936-2aad-4bb1-8a7f-844ecf17f44a';  -- Costel = organiser
  cap uuid;
  tid uuid;
  i int; made int; v text; ok boolean;
  caps uuid[] := array[
    '6e538936-2aad-4bb1-8a7f-844ecf17f44a','813f79fc-f5c3-40a4-8f78-6c502f865f8c',
    '5d66c2fd-c0f7-4746-b089-34bba06fd686','5986ce52-f25b-4b40-b04b-61e0edea5cc4',
    '13dc84e5-09c2-438f-8bd3-c94b3231f75e'];
begin
  -- act as the organiser so the RPC's auth.uid() check passes
  perform set_config('request.jwt.claims', json_build_object('sub', org)::text, true);

  -- ============ CASE A: 8 teams, single elim, Bo3 with a Bo5 final + 3rd place
  insert into tournaments (code,name,format,organiser_id,max_teams,series_format,third_place)
  values (tournament_code(),'__t8__','single_elim',org,8,'{"default":3,"final":5}'::jsonb,true)
  returning id into tid;
  -- one captain per team: the unique index enforces it, so use distinct ids
  for i in 1..8 loop
    insert into tournament_teams (tournament_id,name,captain_id,joined_at)
    values (tid,'Team '||i, ('00000000-0000-4000-8000-0000000000'||lpad(i::text,2,'0'))::uuid, now() + (i||' seconds')::interval);
  end loop;

  made := tournament_start(tid);
  insert into _tt_out(line) values (format('A. 8 teams -> %s matches (expect 8: 4+2+1 bracket + 3rd place) %s',
    made, case when made=8 then 'PASS' else '*** FAIL ***' end));

  select string_agg(format('R%s S%s %s v %s [Bo%s]', round, slot,
           coalesce((select name from tournament_teams where id=m.team_a),'-'),
           coalesce((select name from tournament_teams where id=m.team_b),'-'), best_of), ' | '
           order by round, slot)
    into v from tournament_matches m where tournament_id=tid and bracket='main' and round=1;
  insert into _tt_out(line) values ('   R1: '||v);

  select best_of::text into v from tournament_matches where tournament_id=tid and bracket='main' and round=3;
  insert into _tt_out(line) values (format('   final is Bo%s (expect 5) %s', v, case when v='5' then 'PASS' else '*** FAIL ***' end));

  -- every round-1 match must point at the right round-2 slot
  select count(*)::text into v from tournament_matches a
   join tournament_matches b on b.id = a.next_match_id
   where a.tournament_id=tid and a.round=1 and b.round=2 and b.slot=((a.slot+1)/2);
  insert into _tt_out(line) values (format('   R1->R2 links correct: %s of 4 %s', v, case when v='4' then 'PASS' else '*** FAIL ***' end));

  -- ============ CASE B: 5 teams -> bracket of 8, three byes auto-advanced
  insert into tournaments (code,name,format,organiser_id,max_teams,series_format)
  values (tournament_code(),'__t5__','single_elim',org,8,'{"default":1}'::jsonb) returning id into tid;
  for i in 1..5 loop
    insert into tournament_teams (tournament_id,name,captain_id,joined_at)
    values (tid,'Five '||i, ('00000000-0000-4000-8000-0000000000'||lpad(i::text,2,'0'))::uuid, now() + (i||' seconds')::interval);
  end loop;
  made := tournament_start(tid);
  select count(*)::text into v from tournament_matches where tournament_id=tid and status='done';
  insert into _tt_out(line) values (format('B. 5 teams -> %s matches, %s auto-resolved byes (expect 3) %s',
    made, v, case when v='3' then 'PASS' else '*** FAIL ***' end));
  select count(*)::text into v from tournament_matches
    where tournament_id=tid and round=2 and team_a is not null and team_b is not null;
  insert into _tt_out(line) values (format('   R2 matches already fully populated by byes: %s (expect 1) %s',
    v, case when v='1' then 'PASS' else '*** FAIL ***' end));

  -- ============ CASE C: 2 teams -> a single final
  insert into tournaments (code,name,format,organiser_id,max_teams,series_format)
  values (tournament_code(),'__t2__','single_elim',org,2,'{"default":5}'::jsonb) returning id into tid;
  insert into tournament_teams (tournament_id,name,captain_id) values (tid,'Duo A','00000000-0000-4000-8000-000000000001'::uuid),(tid,'Duo B','00000000-0000-4000-8000-000000000002'::uuid);
  made := tournament_start(tid);
  select label||' Bo'||best_of into v from tournament_matches where tournament_id=tid;
  insert into _tt_out(line) values (format('C. 2 teams -> %s match: %s %s', made, v,
    case when made=1 and v='Final Bo5' then 'PASS' else '*** FAIL ***' end));

  -- ============ CASE D: 6 teams round robin
  insert into tournaments (code,name,format,organiser_id,max_teams,series_format)
  values (tournament_code(),'__trr__','round_robin',org,6,'{"default":3}'::jsonb) returning id into tid;
  for i in 1..6 loop
    insert into tournament_teams (tournament_id,name,captain_id,joined_at)
    values (tid,'RR '||i, ('00000000-0000-4000-8000-0000000000'||lpad(i::text,2,'0'))::uuid, now() + (i||' seconds')::interval);
  end loop;
  made := tournament_start(tid);
  insert into _tt_out(line) values (format('D. 6-team round robin -> %s matches (expect 15) %s',
    made, case when made=15 then 'PASS' else '*** FAIL ***' end));
  select count(distinct round)::text into v from tournament_matches where tournament_id=tid;
  insert into _tt_out(line) values (format('   spread over %s rounds (expect 5) %s', v, case when v='5' then 'PASS' else '*** FAIL ***' end));
  -- nobody plays twice in a round, and everyone plays everyone once
  select count(*)::text into v from (
    select round, team_a as tm from tournament_matches where tournament_id=tid
    union all select round, team_b from tournament_matches where tournament_id=tid) x
    group by round, tm having count(*) > 1;
  insert into _tt_out(line) values (format('   double-booked team-rounds: %s (expect none) %s',
    coalesce(v,'0'), case when v is null then 'PASS' else '*** FAIL ***' end));
  select count(*)::text into v from (
    select least(team_a::text,team_b::text)||greatest(team_a::text,team_b::text) as pair
    from tournament_matches where tournament_id=tid group by 1 having count(*)>1) y;
  insert into _tt_out(line) values (format('   repeated pairings: %s (expect 0) %s', v, case when v='0' then 'PASS' else '*** FAIL ***' end));

  -- ============ CASE E: seeding uses the world ranking
  insert into tournaments (code,name,format,organiser_id,max_teams,series_format)
  values (tournament_code(),'__tseed__','single_elim',org,4,'{"default":3}'::jsonb) returning id into tid;
  -- "Team Falcons" and "Team Spirit" exist in team_ratings; the other two don't
  insert into tournament_teams (tournament_id,name,captain_id,joined_at) values
    (tid,'Nobodies','00000000-0000-4000-8000-000000000001'::uuid, now()),
    (tid,'Team Falcons','00000000-0000-4000-8000-000000000002'::uuid, now() + interval '1 s'),
    (tid,'Randoms','00000000-0000-4000-8000-000000000003'::uuid, now() + interval '2 s'),
    (tid,'Team Spirit','00000000-0000-4000-8000-000000000004'::uuid, now() + interval '3 s');
  made := tournament_start(tid);
  select string_agg(name||'#'||seed, ', ' order by seed) into v
    from tournament_teams where tournament_id=tid;
  insert into _tt_out(line) values ('E. seeded by world ranking: '||v);
  select (select name from tournament_teams where id=m.team_a)||' v '||
         (select name from tournament_teams where id=m.team_b) into v
    from tournament_matches m where tournament_id=tid and round=1 and slot=1;
  insert into _tt_out(line) values ('   R1 slot 1: '||v||'  (top seed should face the bottom seed)');

  -- cleanup
  delete from tournaments where name in ('__t8__','__t5__','__t2__','__trr__','__tseed__');
  insert into _tt_out(line) values ('--- cleanup done ---');
end $t$;

select line from _tt_out order by n;
