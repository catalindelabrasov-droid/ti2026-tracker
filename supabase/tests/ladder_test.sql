drop table if exists _l_out;
create temp table _l_out (n serial, line text);

do $t$
declare
  capA uuid := '00000000-0000-4000-8000-000000000001';
  capB uuid := '00000000-0000-4000-8000-000000000002';
  tA uuid; tB uuid; cid uuid; mid uuid; v text; r record;
begin
  delete from ladder_teams where name in ('Test Alpha','Test Beta');

  perform set_config('request.jwt.claims', json_build_object('sub', capA)::text, true);
  insert into ladder_teams (name,captain_id) values ('Test Alpha',capA) returning id into tA;
  perform set_config('request.jwt.claims', json_build_object('sub', capB)::text, true);
  insert into ladder_teams (name,captain_id) values ('Test Beta',capB) returning id into tB;

  -- A challenges B
  perform set_config('request.jwt.claims', json_build_object('sub', capA)::text, true);
  cid := ladder_challenge(tB, 3, 'gg?', null);
  insert into _l_out(line) values ('1. challenge created PASS');

  -- A cannot challenge twice
  begin
    perform ladder_challenge(tB, 3, null, null);
    insert into _l_out(line) values ('   *** FAIL *** duplicate challenge allowed');
  exception when others then
    insert into _l_out(line) values ('   PASS: duplicate refused -> '||sqlerrm);
  end;

  -- A cannot answer their own challenge
  begin
    perform ladder_respond(cid, true);
    insert into _l_out(line) values ('   *** FAIL *** challenger answered their own challenge');
  exception when others then
    insert into _l_out(line) values ('   PASS: challenger cannot self-accept');
  end;

  -- B accepts
  perform set_config('request.jwt.claims', json_build_object('sub', capB)::text, true);
  v := ladder_respond(cid, true);
  insert into _l_out(line) values (format('2. B accepted -> %s %s', v, case when v='accepted' then 'PASS' else '*** FAIL ***' end));

  -- B reports 0-2 (A won)
  v := ladder_report(cid, 2, 0, '["8912958050"]'::jsonb);
  insert into _l_out(line) values (format('3. first report -> %s (expect reported, nothing settled yet) %s',
    v, case when v='reported' then 'PASS' else '*** FAIL ***' end));
  select rating into v from ladder_teams where id=tA;
  insert into _l_out(line) values (format('   A rating still %s before confirmation %s', v, case when v='1500' then 'PASS' else '*** FAIL ***' end));

  -- A tries to confirm with a DIFFERENT score
  perform set_config('request.jwt.claims', json_build_object('sub', capA)::text, true);
  begin
    perform ladder_report(cid, 2, 1, '[]'::jsonb);
    insert into _l_out(line) values ('   *** FAIL *** mismatched confirmation accepted');
  exception when others then
    insert into _l_out(line) values ('   PASS: mismatch refused -> '||sqlerrm);
  end;

  -- A confirms the same score
  v := ladder_report(cid, 2, 0, '[]'::jsonb);
  insert into _l_out(line) values (format('4. confirmation -> %s %s', v, case when v='confirmed' then 'PASS' else '*** FAIL ***' end));

  for r in select name, rating, rd, games, wins, losses, streak from ladder_teams
           where id in (tA,tB) order by rating desc loop
    insert into _l_out(line) values (format('   %s: %s (rd %s) %sW %sL streak %s',
      r.name, r.rating, r.rd, r.wins, r.losses, r.streak));
  end loop;

  select format('%s -> %s  /  %s -> %s', rating_a_before, rating_a_after, rating_b_before, rating_b_after)
    into v from ladder_matches where challenge_id=cid;
  insert into _l_out(line) values ('   swing recorded: '||v);

  select status into v from ladder_challenges where id=cid;
  insert into _l_out(line) values (format('5. challenge closed -> %s %s', v, case when v='played' then 'PASS' else '*** FAIL ***' end));

  -- standings view
  select string_agg(name||' '||confident_rating||(case when provisional then ' (prov)' else '' end), ', '
                    order by confident_rating desc) into v
    from ladder_standings where id in (tA,tB);
  insert into _l_out(line) values ('6. standings: '||v);

  delete from ladder_teams where id in (tA,tB);
  insert into _l_out(line) values ('--- cleanup done ---');
end $t$;
select line from _l_out order by n;
