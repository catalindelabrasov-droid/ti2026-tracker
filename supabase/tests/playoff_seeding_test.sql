-- The playoff seeding rule, checked on its own.
--
-- A group draw big enough to exercise four and eight groups needs sixteen or
-- more captains, which a test database does not have. The rule is pure
-- arithmetic though, so playoff_seed_map can be checked directly. Two
-- properties have to hold:
--
--   1. No first-round match contains two teams from the same group.
--   2. Each group's two qualifiers sit in opposite halves of the bracket, so
--      the earliest they can meet again is the final.

drop table if exists _p_out;
create temp table _p_out (n serial, line text);

do $t$
declare
  g int; k int; size int; q int;
  smap int[]; ord int[]; who text[]; grp int[];
  i int; s int; j int; a int; b int; h int;
  clash int; half_bad int; ha int; hb int; fails int := 0;
  line text;
begin
  foreach g in array array[2,4,8] loop
    foreach k in array array[2,3] loop
      q := g * k;
      size := 2; while size < q loop size := size * 2; end loop;
      smap := playoff_seed_map(size, g, q);

      -- Label every occupied seat: which group, and which place in that group.
      grp := array_fill(0, array[size]);
      who := array_fill(''::text, array[size]);
      for i in 1..q loop
        j := ((i - 1) % g) + 1;                       -- group
        grp[smap[i]] := j;
        who[smap[i]] := chr(64 + j) || (((i - 1) / g) + 1)::text;
      end loop;

      ord := bracket_seed_order(size);
      clash := 0; line := '';
      for s in 1..(size/2) loop
        a := ord[2*s-1]; b := ord[2*s];
        line := line || format('%s v %s   ',
                  coalesce(nullif(who[a],''),'–'), coalesce(nullif(who[b],''),'–'));
        if grp[a] <> 0 and grp[a] = grp[b] then clash := clash + 1; end if;
      end loop;

      -- Halves: the first size/4 first-round matches are one half.
      half_bad := 0;
      if k = 2 and size >= 4 then
        for j in 1..g loop
          ha := 0; hb := 0;
          for s in 1..(size/2) loop
            a := ord[2*s-1]; b := ord[2*s];
            h := (case when grp[a] = j then 1 else 0 end)
               + (case when grp[b] = j then 1 else 0 end);
            if s <= size/4 then ha := ha + h; else hb := hb + h; end if;
          end loop;
          if ha > 1 or hb > 1 then half_bad := half_bad + 1; end if;
        end loop;
      end if;

      if clash > 0 or half_bad > 0 then fails := fails + 1; end if;
      insert into _p_out(line) values (format(
        '%s groups, top %s -> %s qualifiers in a %s bracket', g, k, q, size));
      insert into _p_out(line) values ('     ' || rtrim(line));
      insert into _p_out(line) values (format(
        '     %s same-group first-round ties, %s groups stuck in one half   %s',
        clash, half_bad,
        case when clash = 0 and half_bad = 0 then 'PASS' else '*** FAIL ***' end));
    end loop;
  end loop;

  insert into _p_out(line) values (case when fails = 0
    then '--- seeding ok ---' else format('--- %s FAILURES ---', fails) end);
end $t$;
select line from _p_out order by n;
