-- Group stage: the draw, Bo2 draws, the tiebreak chain, and playoff seeding.
--
-- The seeding property is the one worth asserting mechanically. It is easy to
-- produce a playoff bracket that looks fine and quietly puts both of a group's
-- qualifiers in the same half, so they meet in the semi-final having already
-- played each other in the group.

drop table if exists _g_out;
create temp table _g_out (n serial, line text);

do $t$
declare
  org uuid; caps uuid[]; tid uuid;
  c int; i int; r record; guard int; loops_done int; flip int;
  st text; champ text; total int; g int; k int;
  draws int; clash int; half_clash int; size int; fails int := 0;
begin
  select array_agg(id order by created_at) into caps from auth.users;
  org := caps[1];
  perform set_config('request.jwt.claims', json_build_object('sub', org)::text, true);

  foreach c in array array[8,10,12,15] loop
    if c > array_length(caps,1) then continue; end if;

    delete from tournaments where code = 'ZG' || c;
    insert into tournaments (code,name,format,organiser_id,max_teams,visibility,series_format)
    values ('ZG'||c,'groups test '||c,'groups',org,32,'unlisted','{"default":3,"final":5}'::jsonb)
    returning id into tid;
    for i in 1..c loop
      insert into tournament_teams (tournament_id,name,captain_id) values (tid,'T'||i,caps[i]);
    end loop;
    perform tournament_start(tid);

    select (stage_config->>'groups')::int, (stage_config->>'advance')::int into g, k
      from tournaments where id = tid;
    insert into _g_out(line) values (format('%2s teams -> %s groups, top %s advance', c, g, k));

    -- Group sizes from the snake draw.
    for r in select group_no, count(*) n, string_agg(seed::text,',' order by seed) seeds
               from tournament_teams where tournament_id=tid group by group_no order by group_no loop
      insert into _g_out(line) values (format('     group %s: %s teams, seeds %s', r.group_no, r.n, r.seeds));
    end loop;

    -- Play the groups. Every third fixture is left level, so draws are
    -- exercised rather than merely permitted.
    guard := 0; flip := 0;
    loop
      guard := guard + 1; exit when guard > 400;
      loops_done := 0;
      for r in select id, best_of, bracket from tournament_matches
                where tournament_id = tid and status <> 'done'
                  and team_a is not null and team_b is not null
      loop
        flip := flip + 1;
        if r.bracket = 'group' and r.best_of % 2 = 0 and flip % 3 = 0 then
          perform tournament_report(r.id, r.best_of/2, r.best_of/2, '[]'::jsonb);
        elsif flip % 2 = 0 then
          perform tournament_report(r.id, 0, r.best_of/2+1, '[]'::jsonb);
        else
          perform tournament_report(r.id, r.best_of/2+1, 0, '[]'::jsonb);
        end if;
        loops_done := loops_done + 1;
      end loop;
      exit when loops_done = 0;
    end loop;

    select count(*) into draws from tournament_matches
     where tournament_id=tid and bracket='group' and status='done' and winner_id is null;

    -- No first-round playoff match may contain two teams from one group.
    select count(*) into clash from tournament_matches m
      join tournament_teams a on a.id=m.team_a
      join tournament_teams b on b.id=m.team_b
     where m.tournament_id=tid and m.bracket='main' and m.round=1
       and a.group_no = b.group_no;

    -- And each group's two qualifiers must sit in opposite halves, so the
    -- earliest they can meet again is the final.
    select count(*) into size from tournament_matches
     where tournament_id=tid and bracket='main' and round=1;
    if k = 2 and g >= 2 and size >= 2 then
      select count(*) into half_clash from (
        select a.group_no
          from tournament_matches m
          join tournament_teams a on a.id in (m.team_a, m.team_b)
         where m.tournament_id=tid and m.bracket='main' and m.round=1
         group by a.group_no,
                  case when m.slot <= size/2 then 1 else 2 end
        having count(*) > 1) z;
    else half_clash := 0; end if;

    select status into st from tournaments where id=tid;
    select tt.name into champ from tournaments t2 join tournament_teams tt on tt.id=t2.champion_id
     where t2.id=tid;
    select count(*) into total from tournament_matches where tournament_id=tid and status<>'done';

    if st<>'finished' or champ is null or total>0 or clash>0 or half_clash>0 or draws=0 then
      fails := fails + 1;
    end if;
    insert into _g_out(line) values (format(
      '     %s draws, %s same-group R1 ties, %s same-half pairs, %s unplayed, %s, champion %s   %s',
      draws, clash, half_clash, total, st, coalesce(champ,'NONE'),
      case when st='finished' and champ is not null and total=0
                and clash=0 and half_clash=0 and draws>0 then 'PASS' else '*** FAIL ***' end));

    if c = 10 then
      for r in select pos, team_name, group_no, played, won, drawn, lost, points,
                      game_diff, h2h_points, h2h_diff
                 from tournament_group_standings(tid, null) order by group_no, pos loop
        insert into _g_out(line) values (format(
          '       %s %s. %-4s %sW %sD %sL  %s pts  gd %s  (h2h %s/%s)',
          r.group_no, r.pos, r.team_name, r.won, r.drawn, r.lost, r.points,
          r.game_diff, r.h2h_points, r.h2h_diff));
      end loop;
    end if;

    delete from tournaments where id=tid;
  end loop;

  insert into _g_out(line) values (case when fails=0
    then '--- groups ok ---' else format('--- %s FAILURES ---', fails) end);
end $t$;
select line from _g_out order by n;
