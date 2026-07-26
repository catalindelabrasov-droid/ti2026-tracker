-- Every bracket must be able to finish.
--
-- Written after discovering that double elimination deadlocked permanently for
-- every field size that was not a power of two: a bye has no loser, so the
-- losers-bracket slot it fed was never filled and nothing existed to clear it.
-- This plays each tournament out to the end and insists it reaches 'finished'
-- with a champion.

drop table if exists _b_out;
create temp table _b_out (n serial, line text);

do $t$
declare
  org uuid; caps uuid[]; tid uuid; fmt text;
  i int; c int; r record; guard int; played int;
  st text; total int; left_n int; champ uuid; champ_name text;
  fails int := 0;
begin
  select array_agg(id order by created_at) into caps from auth.users;
  org := caps[1];
  perform set_config('request.jwt.claims', json_build_object('sub', org)::text, true);

  foreach fmt in array array['single_elim','double_elim'] loop
    insert into _b_out(line) values ('=== ' || fmt || ' ===');
    foreach c in array array[2,3,4,5,6,7,8,9,11,12,13,16] loop
      if c > array_length(caps,1) then continue; end if;

      delete from tournaments where code = 'ZT' || c;
      insert into tournaments (code,name,format,organiser_id,max_teams,visibility,series_format,third_place)
      values ('ZT'||c, 'bracket test '||c, fmt, org, 32, 'unlisted',
              '{"default":1}'::jsonb, fmt = 'single_elim')
      returning id into tid;
      for i in 1..c loop
        insert into tournament_teams (tournament_id,name,captain_id) values (tid,'T'||i,caps[i]);
      end loop;
      perform tournament_start(tid);

      -- Play everything playable; team_a always wins. The organiser reports,
      -- which settles immediately, so this walks the whole event.
      guard := 0;
      loop
        guard := guard + 1;
        exit when guard > 300;
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

      select status, champion_id into st, champ from tournaments where id = tid;
      select count(*) into total  from tournament_matches where tournament_id = tid;
      select count(*) into left_n from tournament_matches where tournament_id = tid and status <> 'done';
      select name into champ_name from tournament_teams where id = champ;

      if st <> 'finished' or champ is null then fails := fails + 1; end if;
      insert into _b_out(line) values (format('  %2s teams: %-9s %s unplayed of %s, champion %s   %s',
        c, st, left_n, total, coalesce(champ_name,'NONE'),
        case when st = 'finished' and champ is not null then 'PASS' else '*** FAIL ***' end));

      delete from tournaments where id = tid;
    end loop;
  end loop;

  insert into _b_out(line) values (case when fails = 0
    then '--- all brackets complete ---' else format('--- %s FAILURES ---', fails) end);
end $t$;
select line from _b_out order by n;
