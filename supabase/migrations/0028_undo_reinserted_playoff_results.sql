-- The same clean-up as 0027, because 0027 did not hold.
--
-- 0027 deleted the 14 fabricated playoff results. The very next auto-update
-- ran from the still-corrupted data.json and put all 14 straight back, and
-- once data.json was repaired they simply stayed: push_league_backend only
-- ever upserted, so a match_results row was permanent once written.
--
-- The end state was the worst of both. matches.status was correctly back to
-- 'upcoming', but enforce_prediction_lock refuses a pick when EITHER the
-- status is closed OR a result row exists - so the playoffs remained
-- unpickable with nothing in data.json left to explain why.
--
-- update_data.py now reconciles instead of appending: any result row for a
-- fixture data.json no longer considers decided is withdrawn on the next run
-- (see _supabase_delete_in and the reconciliation block in
-- push_league_backend). This migration clears the backlog that predates it.
--
-- Safe to run more than once - it deletes by a predicate, not by id list, and
-- a second run simply finds nothing.

begin;

do $$
declare
  n int;
begin
  select count(*) into n
    from match_results r
    join matches m on m.match_id = r.match_id
   where m.scheduled_at > now() + interval '6 hours';
  raise notice 'withdrawing % result row(s) for fixtures that have not started', n;
end $$;

delete from match_results r
 using matches m
 where m.match_id = r.match_id
   and m.scheduled_at > now() + interval '6 hours';

update matches
   set status = 'upcoming',
       updated_at = now()
 where scheduled_at > now() + interval '6 hours'
   and status in ('completed', 'live');

-- Prove the lock is genuinely open again before committing: no unplayed
-- fixture may carry either a closed status or a result row.
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
    raise exception 'still % unplayed fixture(s) closed to predictions', leftover;
  end if;
end $$;

commit;
