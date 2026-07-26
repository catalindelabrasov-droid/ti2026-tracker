-- Swiss: pairing, byes, thresholds, standings, and reaching an end.
--
-- The interesting properties are not "does it produce matches" but: does it
-- ever pair the same two teams twice, does an odd field get a fair bye, does a
-- team that has clinched stop being asked to play, and does the whole thing
-- terminate in a champion.

drop table if exists _s_out;
create temp table _s_out (n serial, line text);

do $t$
declare
  org uuid; caps uuid[]; tid uuid;
  c int; i int; r record; guard int; played int;
  st text; champ text; rounds_played int;
  dupes int; total int; fails int := 0;
  r1 text;
begin
  select array_agg(id order by created_at) into caps from auth.users;
  org := caps[1];
  perform set_config('request.jwt.claims', json_build_object('sub', org)::text, true);

  foreach c in array array[4,5,6,7,8,9,11,13] loop
    if c > array_length(caps,1) then continue; end if;

    delete from tournaments where code = 'ZS' || c;
    insert into tournaments (code,name,format,organiser_id,max_teams,visibility,series_format)
    values ('ZS'||c,'swiss test '||c,'swiss',org,32,'unlisted','{"default":1,"decider":3}'::jsonb)
    returning id into tid;
    for i in 1..c loop
      insert into tournament_teams (tournament_id,name,captain_id) values (tid,'T'||i,caps[i]);
    end loop;
    perform tournament_start(tid);

    -- Round one must be top half against bottom half: seed 1 plays seed
    -- 1+n/2, not seed 2 and not the bottom seed.
    select string_agg(ta.seed || 'v' || coalesce(tb.seed::text,'bye'), ' ' order by m.slot)
      into r1
      from tournament_matches m
      join tournament_teams ta on ta.id = m.team_a
      left join tournament_teams tb on tb.id = m.team_b
     where m.tournament_id = tid and m.bracket='swiss' and m.round=1;
    insert into _s_out(line) values (format('%2s teams  round 1: %s', c, r1));

    guard := 0;
    loop
      guard := guard + 1;
      exit when guard > 200;
      played := 0;
      for r in select id, best_of from tournament_matches
                where tournament_id = tid and status <> 'done'
                  and team_a is not null and team_b is not null
      loop
        perform tournament_report(r.id, r.best_of / 2 + 1, 0, '[]'::jsonb);
        played := played + 1;
      end loop;
      exit when played = 0;
    end loop;

    -- No pairing may ever repeat inside the Swiss stage.
    select count(*) into dupes from (
      select least(team_a::text,team_b::text) a, greatest(team_a::text,team_b::text) b
        from tournament_matches
       where tournament_id=tid and bracket='swiss' and team_a is not null and team_b is not null
       group by 1,2 having count(*) > 1) d;

    select max(round) into rounds_played from tournament_matches
     where tournament_id=tid and bracket='swiss';
    select status into st from tournaments where id=tid;
    select tt.name into champ from tournaments t2 join tournament_teams tt on tt.id=t2.champion_id
     where t2.id=tid;
    select count(*) into total from tournament_matches where tournament_id=tid and status<>'done';

    if dupes > 0 or st <> 'finished' or champ is null or total > 0 then fails := fails + 1; end if;
    insert into _s_out(line) values (format(
      '          %s rounds, %s repeat pairings, %s unplayed, %s, champion %s   %s',
      rounds_played, dupes, total, st, coalesce(champ,'NONE'),
      case when dupes=0 and st='finished' and champ is not null and total=0
           then 'PASS' else '*** FAIL ***' end));

    -- Standings for the eight-team case, to eyeball the tiebreakers.
    if c = 8 then
      for r in select rank, name, wins, losses, byes, omw, h2h, game_diff, state
                 from tournament_swiss_standings(tid) order by rank loop
        insert into _s_out(line) values (format(
          '            %s. %-4s %s-%s byes:%s omw:%s h2h:%s gd:%s %s',
          r.rank, r.name, r.wins, r.losses, r.byes, r.omw, r.h2h, r.game_diff, r.state));
      end loop;
    end if;

    delete from tournaments where id=tid;
  end loop;

  insert into _s_out(line) values (case when fails = 0
    then '--- swiss ok ---' else format('--- %s FAILURES ---', fails) end);
end $t$;
select line from _s_out order by n;
