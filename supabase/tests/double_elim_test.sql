drop table if exists _de_out;
create temp table _de_out (n serial, line text);

do $t$
declare
  org uuid := '6e538936-2aad-4bb1-8a7f-844ecf17f44a';
  tid uuid; i int; made int; v text; mid uuid;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', org)::text, true);

  insert into tournaments (code,name,format,organiser_id,max_teams,series_format)
  values (tournament_code(),'__de8__','double_elim',org,8,'{"default":3,"final":5}'::jsonb)
  returning id into tid;
  for i in 1..8 loop
    insert into tournament_teams (tournament_id,name,captain_id,joined_at)
    values (tid,'DE'||i, ('00000000-0000-4000-8000-0000000000'||lpad(i::text,2,'0'))::uuid, now()+(i||' s')::interval);
  end loop;
  made := tournament_start(tid);

  insert into _de_out(line) values (format('8-team double elim -> %s matches (expect 14 = 2n-2, no bracket reset) %s',
    made, case when made=14 then 'PASS' else '*** FAIL ***' end));

  select string_agg(bracket||' R'||round||':'||cnt, '  ' order by bracket, round) into v
  from (select bracket, round, count(*) cnt from tournament_matches
        where tournament_id=tid group by bracket, round) x;
  insert into _de_out(line) values ('   shape: '||v);

  -- every winners match except the final must drop its loser somewhere
  select count(*)::text into v from tournament_matches
   where tournament_id=tid and bracket='main' and loser_match_id is null;
  insert into _de_out(line) values (format('   winners matches with nowhere to drop: %s (expect 0 - even the winners final drops to the losers final) %s',
    v, case when v='0' then 'PASS' else '*** FAIL ***' end));

  -- the grand final must be fed from both sides
  select count(*)::text into v from tournament_matches
   where tournament_id=tid and next_match_id=(select id from tournament_matches
     where tournament_id=tid and bracket='grand_final');
  insert into _de_out(line) values (format('   feeders into the grand final: %s (expect 2) %s',
    v, case when v='2' then 'PASS' else '*** FAIL ***' end));

  -- no losers match may be orphaned except the losers final
  select count(*)::text into v from tournament_matches
   where tournament_id=tid and bracket='losers' and next_match_id is null;
  insert into _de_out(line) values (format('   losers matches with no onward link: %s (expect 0 - the losers final feeds the grand final) %s',
    v, case when v='0' then 'PASS' else '*** FAIL ***' end));

  -- ---- play it out: top seed wins everything, and check a loser really drops
  select id into mid from tournament_matches where tournament_id=tid and bracket='main' and round=1 and slot=1;
  select (select name from tournament_teams where id=team_a)||' vs '||
         (select name from tournament_teams where id=team_b) into v
    from tournament_matches where id=mid;
  insert into _de_out(line) values ('   first winners match: '||v);
  perform tournament_report(mid, 2, 0, '[]'::jsonb);   -- organiser reports => settles
  select (select name from tournament_teams where id=team_a)||' / '||
         coalesce((select name from tournament_teams where id=team_b),'—') into v
    from tournament_matches where tournament_id=tid and bracket='losers' and round=1 and slot=1;
  insert into _de_out(line) values ('   losers R1 S1 now holds: '||v||'  (the beaten team should be here)');

  select status into v from tournament_matches where id=mid;
  insert into _de_out(line) values (format('   reported match status: %s (expect done) %s',
    v, case when v='done' then 'PASS' else '*** FAIL ***' end));

  -- guard: a Bo3 cannot end 3-0
  begin
    select id into mid from tournament_matches where tournament_id=tid and bracket='main' and round=1 and slot=2;
    perform tournament_report(mid, 3, 0, '[]'::jsonb);
    insert into _de_out(line) values ('   *** FAIL *** a 3-0 was accepted in a Bo3');
  exception when others then
    insert into _de_out(line) values ('   PASS: impossible score rejected -> '||sqlerrm);
  end;

  delete from tournaments where name='__de8__';
  insert into _de_out(line) values ('--- cleanup done ---');
end $t$;
select line from _de_out order by n;
