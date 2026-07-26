drop table if exists _t2;
create temp table _t2 (n serial, line text);

do $t$
declare
  u1 uuid := '6e538936-2aad-4bb1-8a7f-844ecf17f44a';  -- Costel
  u2 uuid := '813f79fc-f5c3-40a4-8f78-6c502f865f8c';  -- Jane
  lg uuid;
  v text;
begin
  create temp table _bk_m  on commit drop as select * from matches       where match_id like 'nr-%';
  create temp table _bk_r  on commit drop as select * from match_results where match_id like 'nr-%';

  insert into leagues (name, code, admin_id, rules) values (
    '__newrules__','NRTEST', u1,
    '{"winner":{"on":true,"pts":10},"exactScore":{"on":false,"pts":15},
      "cleanSweep":{"on":true,"pts":8},"upsetBonus":{"on":true,"pts":10},
      "streakBonus":{"on":true,"pts":5},"perfectDay":{"on":true,"pts":25},
      "scoreMode":"flat","lockLeadMs":3600000}'::jsonb)
  returning id into lg;
  insert into league_members (league_id,user_id,username) values (lg,u1,'Costel'),(lg,u2,'Jane');

  -- Ratings so an upset is detectable: Underdog is rated below Favourite.
  insert into team_ratings (valve_id,name,glicko,conservative,rd,games,source,as_of)
  values (900001,'Favourite',2000,1900,50,20,'test',now()),
         (900002,'Underdog',1500,1400,50,20,'test',now())
  on conflict (valve_id) do update set glicko=excluded.glicko, name=excluded.name;

  -- Day 1: three matches. Costel gets all three right (perfect day + streak).
  insert into matches (match_id,team_a,team_b,best_of,scheduled_at,stage,status) values
    ('nr-1','Underdog','Favourite',3,'2026-09-01 10:00+00','group','upcoming'),
    ('nr-2','Alpha','Beta',      3,'2026-09-01 14:00+00','group','upcoming'),
    ('nr-3','Gamma','Delta',     3,'2026-09-01 18:00+00','group','upcoming'),
    ('nr-4','Eta','Theta',       3,'2026-09-02 10:00+00','group','upcoming');

  insert into predictions (league_id,user_id,match_id,pick,score_a,score_b,locked,locked_at) values
    (lg,u1,'nr-1','Underdog',2,0,true,now()),   -- upset + clean sweep + winner
    (lg,u1,'nr-2','Alpha',   2,1,true,now()),   -- winner
    (lg,u1,'nr-3','Gamma',   2,0,true,now()),   -- winner + clean sweep  => perfect day, streak 3
    (lg,u1,'nr-4','Eta',     2,0,true,now()),   -- wrong, breaks the streak
    (lg,u2,'nr-1','Favourite',2,0,true,now()),  -- wrong
    (lg,u2,'nr-2','Alpha',   2,0,true,now()),   -- winner + clean sweep
    (lg,u2,'nr-3','Delta',   2,0,true,now());   -- wrong  => no perfect day, streak 1

  insert into match_results (match_id,winner,score_a,score_b) values
    ('nr-1','Underdog',2,0), ('nr-2','Alpha',2,1),
    ('nr-3','Gamma',2,0),    ('nr-4','Theta',0,2);

  insert into _t2(line)
  select format('%s: points=%s correct=%s streak=%s (expect %s)',
                l.username,l.points,l.correct,l.best_streak,e.note)
  from league_leaderboard(lg) l
  join (values
    -- Costel: m1 10+8 sweep+10 upset =28 | m2 10 | m3 10+8=18 | m4 0
    --         => 56 match + streak(3 correct = 2 extras x5 =10) + perfect day 25 = 91
    ('Costel',  '91: 56 match + 10 streak + 25 perfect day'),
    -- Jane: m1 0 | m2 10+8=18 | m3 0 => 18, streak 1 (no extras), no perfect day
    ('Jane',    '18, streak 1, no perfect day')
  ) as e(name,note) on e.name = l.username;

  -- Turn the new rules off: only winner + cleanSweep-less base should remain.
  update leagues set rules = jsonb_set(jsonb_set(jsonb_set(rules,
        '{upsetBonus,on}','false'),'{streakBonus,on}','false'),'{perfectDay,on}','false')
    where id = lg;
  select points into v from league_leaderboard(lg) where username='Costel';
  insert into _t2(line) values (format('Costel with upset/streak/perfectDay OFF = %s (expect 46 = 56-10 upset) %s',
      v, case when v='46' then 'PASS' else '*** FAIL ***' end));

  -- cleanup
  delete from predictions where league_id=lg;
  delete from league_members where league_id=lg;
  delete from leagues where id=lg;
  delete from match_results where match_id like 'nr-%';
  delete from matches where match_id like 'nr-%';
  delete from team_ratings where source='test';
  insert into _t2(line) values ('--- cleanup done ---');
end $t$;

select line from _t2 order by n;
