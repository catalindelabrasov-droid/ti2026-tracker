-- Undo the playoff results that were never played.
--
-- On 16 Aug 2026 the 16:01Z auto-update ingested the entire TI playoff bracket
-- as finished - fourteen fixtures plus a grand final reading
-- "TEAM VISION 3-2 Team Liquid" - for matches scheduled 20-23 Aug. Four days
-- early. The upstream cause is not knowable from here; the clock refutes it
-- regardless, and update_data.py now refuses any completed result whose kickoff
-- is still more than six hours away (see _build_match, and
-- tools/test_no_future_results.py which replays this exact incident).
--
-- This cleans up what the bad run wrote. Three separate harms:
--
--   1. matches.status = 'completed' on fourteen unplayed fixtures. The
--      prediction lock closes on that status, so NOBODY COULD PICK THE
--      PLAYOFFS. Reopening them is the urgent half.
--   2. match_results rows for those fixtures. enforce_prediction_lock also
--      refuses a pick when a result row exists, so these must go too - and
--      they are what league scoring settles against.
--   3. Anything already scored from them.
--
-- DELIBERATELY SCOPED BY TIME, NOT BY ID. Listing the fourteen ids would be
-- easy to get wrong and would miss any that arrived in a later bad run before
-- this is applied. "scheduled_at is in the future" is the same test the
-- application guard uses, so the two cannot disagree.
--
-- The group stage is untouched by construction: every group fixture is in the
-- past, so no row there can match this predicate.

begin;

-- What is about to change, in the transaction log.
do $$
declare
  n_res int;
  n_mat int;
begin
  select count(*) into n_res
    from match_results r
    join matches m on m.match_id = r.match_id
   where m.scheduled_at > now() + interval '6 hours';

  select count(*) into n_mat
    from matches
   where scheduled_at > now() + interval '6 hours'
     and status in ('completed', 'live');

  raise notice 'removing % fabricated match_results row(s)', n_res;
  raise notice 'reopening % match(es) that had not been played', n_mat;
end $$;

-- 1. Drop the result rows for fixtures that have not started.
delete from match_results r
 using matches m
 where m.match_id = r.match_id
   and m.scheduled_at > now() + interval '6 hours';

-- 2. Reopen the fixtures themselves.
--    NOTE: matches carries no score columns - it is
--    (match_id, team_a, team_b, best_of, scheduled_at, stage, status,
--    updated_at) and the scores live only in match_results, which step 1
--    already removed. A first draft of this migration tried to null
--    team_a_score/team_b_score here and would simply have errored.
update matches
   set status = 'upcoming',
       updated_at = now()
 where scheduled_at > now() + interval '6 hours'
   and status in ('completed', 'live');

-- 3. Prove it worked before committing. If anything survives the clean-up the
--    whole migration aborts rather than half-applying.
do $$
declare
  leftover int;
begin
  select count(*) into leftover
    from matches m
    left join match_results r on r.match_id = m.match_id
   where m.scheduled_at > now() + interval '6 hours'
     and (m.status in ('completed', 'live') or r.match_id is not null);

  if leftover > 0 then
    raise exception 'still % unplayed fixture(s) carrying a result or a closed status', leftover;
  end if;
end $$;

commit;
