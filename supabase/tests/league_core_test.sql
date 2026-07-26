-- End-to-end test of the league core scoring. Creates an isolated test
-- league, exercises every scoring path, prints expected vs actual, cleans up.
drop table if exists _t_out;
create temp table _t_out (n serial, line text);

do $t$
declare
  u1 uuid := '6e538936-2aad-4bb1-8a7f-844ecf17f44a';  -- Costel
  u2 uuid := '813f79fc-f5c3-40a4-8f78-6c502f865f8c';  -- Jane
  u3 uuid := '5d66c2fd-c0f7-4746-b089-34bba06fd686';  -- Janica
  u4 uuid := '5986ce52-f25b-4b40-b04b-61e0edea5cc4';  -- andrei
  u5 uuid := '13dc84e5-09c2-438f-8bd3-c94b3231f75e';  -- testcatalin
  lg uuid;
  msg text;
begin
  -- ---- setup -------------------------------------------------------------
  insert into leagues (name, code, admin_id, rules) values (
    '__core_test__', 'CORETEST', u1,
    '{"winner":{"on":true,"pts":10},"exactScore":{"on":true,"pts":15},
      "gameCountOU":{"on":true,"pts":6},"loneWolf":{"on":true,"pts":5},
      "negativePoints":{"on":true,"pts":5},"champion":{"on":true,"pts":50},
      "topFour":{"on":true,"pts":20},"champFromLB":{"on":true,"pts":20},
      "scoreMode":"flat","lockLeadMs":3600000}'::jsonb)
  returning id into lg;

  insert into league_members (league_id, user_id, username) values
    (lg,u1,'Costel'),(lg,u2,'Jane'),(lg,u3,'Janica'),(lg,u4,'andrei'),(lg,u5,'testcatalin');

  -- Outcome resolution keys off fixed bracket ids (me-r5m1 etc.), so the test
  -- has to borrow those rows. Snapshot them first and restore on the way out,
  -- otherwise running this against the live project would overwrite the real
  -- bracket with Alpha/Beta placeholders.
  create temp table _t_matches_backup on commit drop as
    select * from matches where match_id like 'me-r%';
  create temp table _t_results_backup on commit drop as
    select * from match_results where match_id like 'me-r%';

  -- Schedule everything in the future so the lock trigger allows setup.
  insert into matches (match_id, team_a, team_b, best_of, scheduled_at, stage, status) values
    ('ct-gs-1','Alpha','Beta', 3, now()+interval '2 days','group','upcoming'),
    ('ct-gs-2','Gamma','Delta',3, now()+interval '2 days','group','upcoming'),
    ('me-r1m1','Alpha','Beta', 3, now()+interval '3 days','playoffs','upcoming'),
    ('me-r1m2','Gamma','Delta',3, now()+interval '3 days','playoffs','upcoming'),
    ('me-r3m1','Gamma','Epsilon',3, now()+interval '4 days','playoffs','upcoming'),
    ('me-r4m1','Alpha','Delta',3, now()+interval '4 days','playoffs','upcoming'),
    ('me-r4m2','Gamma','Delta',3, now()+interval '4 days','playoffs','upcoming'),
    ('me-r5m1','Alpha','Gamma',5, now()+interval '5 days','playoffs','upcoming')
  on conflict (match_id) do update set team_a=excluded.team_a, team_b=excluded.team_b,
    scheduled_at=excluded.scheduled_at;

  -- Match 1: Alpha beats Beta 2-1. Alpha is the popular pick (4 of 5).
  insert into predictions (league_id,user_id,match_id,pick,score_a,score_b,locked,locked_at) values
    (lg,u1,'ct-gs-1','Alpha',2,1,true,now()),   -- winner + exact + gameCount
    (lg,u2,'ct-gs-1','Beta', 2,0,true,now()),   -- wrong -> negative points
    (lg,u3,'ct-gs-1','Alpha',2,0,true,now()),   -- winner only
    (lg,u4,'ct-gs-1','Alpha',2,0,true,now()),
    (lg,u5,'ct-gs-1','Alpha',2,0,true,now());

  -- Match 2: Delta beats Gamma 2-0. Only u2 backed Delta -> lone wolf (1/5=0.2).
  insert into predictions (league_id,user_id,match_id,pick,score_a,score_b,locked,locked_at) values
    (lg,u1,'ct-gs-2','Gamma',2,1,true,now()),
    (lg,u2,'ct-gs-2','Delta',0,2,true,now()),   -- winner + exact + gameCount + loneWolf
    (lg,u3,'ct-gs-2','Gamma',2,0,true,now()),
    (lg,u4,'ct-gs-2','Gamma',2,0,true,now()),
    (lg,u5,'ct-gs-2','Gamma',2,0,true,now());

  insert into outcome_predictions (league_id,user_id,kind,value,locked) values
    (lg,u1,'champion','"Alpha"'::jsonb,true),                                  -- correct
    (lg,u2,'champion','"Beta"'::jsonb,true),                                   -- wrong
    (lg,u1,'topFour','["Alpha","Delta","Gamma","Zeta"]'::jsonb,true),          -- 3 of 4
    (lg,u3,'topFour','["Zeta","Iota","Kappa","Omega"]'::jsonb,true);           -- 0 of 4

  -- Results land after the picks (as in real life).
  insert into match_results (match_id,winner,score_a,score_b) values
    ('ct-gs-1','Alpha',2,1),
    ('ct-gs-2','Delta',0,2),
    ('me-r4m2','Gamma',2,1),     -- LB final won by Gamma (not the champion)
    ('me-r5m1','Alpha',3,1)      -- champion = Alpha, from the upper bracket
  on conflict (match_id) do update set winner=excluded.winner,
    score_a=excluded.score_a, score_b=excluded.score_b;

  -- Per-game rows for the reverse-sweep / first-game paths.
  insert into match_games (match_id,game_no,winner,duration,start_time) values
    ('ct-gs-1',1,'Beta', 2100, now()),
    ('ct-gs-1',2,'Alpha',2400, now()),
    ('ct-gs-1',3,'Alpha',1980, now())
  on conflict (match_id,game_no) do update set winner=excluded.winner;

  -- ---- assertions --------------------------------------------------------
  -- Expected match points:
  --   Costel  m1 = 10 winner + 15 exact + 6 gameCount = 31; m2 = -5 wrong  => 26
  --   Jane    m1 = -5 wrong; m2 = 10 + 15 + 6 + 5 loneWolf (1 of 5)        => 31
  --   others  m1 = 10 winner; m2 = -5 wrong + 6 gameCount (2-0 = 2 games)  => 11
  -- Outcomes: Costel champion 50 + topFour 3 hits x 20 = 110 -> 136 total.
  insert into _t_out(line)
  select format('%s: points=%s (expect %s) %s | correct=%s exact=%s outcome=%s',
                l.username, l.points, e.exp,
                case when l.points = e.exp then 'PASS' else '*** FAIL ***' end,
                l.correct, l.exact_hits, l.outcome_points)
  from league_leaderboard(lg) l
  join (values ('Costel',136),('Jane',31),('Janica',11),('andrei',11),('testcatalin',11))
       as e(name, exp) on e.name = l.username;

  -- champFromLB: make the champion come out of the lower bracket (+20).
  update match_results set winner='Alpha' where match_id='me-r4m2';
  select points into msg from league_leaderboard(lg) where username='Costel';
  insert into _t_out(line) values (
    format('B. champFromLB: Costel=%s (expect 156) %s', msg,
           case when msg='156' then 'PASS' else '*** FAIL ***' end));
  update match_results set winner='Gamma' where match_id='me-r4m2';

  -- Round-weighted mode: both test matches are group stage, so x1 -> unchanged.
  update leagues set rules = jsonb_set(rules,'{scoreMode}','"weighted"') where id=lg;
  select points into msg from league_leaderboard(lg) where username='Costel';
  insert into _t_out(line) values (
    format('C. weighted mode: Costel=%s (expect 136, group stage is x1) %s', msg,
           case when msg='136' then 'PASS' else '*** FAIL ***' end));
  update leagues set rules = jsonb_set(rules,'{scoreMode}','"flat"') where id=lg;

  -- Disabling a rule must actually change the score.
  update leagues set rules = jsonb_set(rules,'{exactScore,on}','false') where id=lg;
  select points into msg from league_leaderboard(lg) where username='Costel';
  insert into _t_out(line) values (
    format('D. exactScore off: Costel=%s (expect 121 = 136-15) %s', msg,
           case when msg='121' then 'PASS' else '*** FAIL ***' end));
  update leagues set rules = jsonb_set(rules,'{exactScore,on}','true') where id=lg;

  -- A league with an empty rules object must still score the on-by-default
  -- rules: winner 10 + exact 15 (no gameCount/negative/loneWolf) + outcomes.
  update leagues set rules='{}'::jsonb where id=lg;
  select points into msg from league_leaderboard(lg) where username='Costel';
  insert into _t_out(line) values (
    format('D2. empty rules -> defaults: Costel=%s (expect 135 = 25 match + 110 outcome) %s', msg,
           case when msg='135' then 'PASS' else '*** FAIL ***' end));

  -- ---- lock enforcement --------------------------------------------------
  insert into _t_out(line) values ('--- E. lock enforcement ---');
  begin
    insert into predictions (league_id,user_id,match_id,pick,score_a,score_b,locked)
    values (lg,u3,'ct-gs-1','Beta',0,2,true);
    insert into _t_out(line) values ('FAIL: prediction accepted for a match that already has a result');
  exception when others then
    insert into _t_out(line) values ('PASS: result exists -> % ' || sqlerrm);
  end;

  update matches set scheduled_at = now() - interval '10 minutes' where match_id='me-r1m1';
  begin
    insert into predictions (league_id,user_id,match_id,pick,score_a,score_b,locked)
    values (lg,u3,'me-r1m1','Alpha',2,0,true);
    insert into _t_out(line) values ('FAIL: prediction accepted after the deadline');
  exception when others then
    insert into _t_out(line) values ('PASS: deadline passed -> % ' || sqlerrm);
  end;

  begin
    insert into predictions (league_id,user_id,match_id,pick,score_a,score_b,locked)
    values (lg,u3,'me-r1m2','Gamma',2,0,true);
    insert into _t_out(line) values ('PASS: future match accepted');
  exception when others then
    insert into _t_out(line) values ('FAIL: future match rejected -> % ' || sqlerrm);
  end;

  -- ---- cleanup -----------------------------------------------------------
  delete from predictions where league_id = lg;
  delete from outcome_predictions where league_id = lg;
  delete from league_members where league_id = lg;
  delete from leagues where id = lg;
  delete from match_results where match_id in ('ct-gs-1','ct-gs-2');
  delete from match_games where match_id like 'ct-%';
  delete from matches where match_id like 'ct-%';
  -- Put the real bracket back exactly as we found it.
  delete from match_results where match_id like 'me-r%';
  delete from matches where match_id like 'me-r%';
  insert into matches select * from _t_matches_backup;
  insert into match_results select * from _t_results_backup;
  insert into _t_out(line) values (format(
    '--- cleanup done; restored %s bracket match(es), %s result(s) ---',
    (select count(*) from _t_matches_backup),
    (select count(*) from _t_results_backup)));
end $t$;

select line from _t_out order by n;
