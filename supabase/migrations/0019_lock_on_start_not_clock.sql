-- Keep predictions open until a match actually STARTS, not until its scheduled
-- slot passes.
--
-- TI runs matches back to back and the schedule slips constantly. On 13 Aug 2026
-- round two's fixtures sat 28 to 78 minutes past their published start time
-- without having been played, and every one of them showed "Locking deadline
-- passed" — nobody could predict matches that had not begun. The league had
-- already set lockLeadMs to one minute trying to work around it, which did not
-- help, because the deadline is measured from a scheduled time that is wrong.
--
-- The other two rules already say "it started": a result exists, or the match is
-- live/completed. Those are observations, not predictions about the clock. So
-- the time rule becomes OPTIONAL: lockLeadMs = 0 means "open until it starts",
-- and any positive value keeps the old behaviour for leagues that want a
-- genuine cut-off.

create or replace function public.enforce_prediction_lock()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_sched   timestamptz;
  v_status  text;
  v_lead_ms bigint;
begin
  if exists (select 1 from match_results where match_id = new.match_id) then
    raise exception 'This match already has a result - predictions are closed.'
      using errcode = 'P0001';
  end if;

  select scheduled_at, status into v_sched, v_status
    from matches where match_id = new.match_id;

  -- The honest test: it is under way.
  if v_status in ('live', 'completed') then
    raise exception 'This match has already started - predictions are closed.'
      using errcode = 'P0001';
  end if;

  if v_sched is null then
    return new;  -- schedule unknown and not started: nothing to enforce yet
  end if;

  select coalesce((rules ->> 'lockLeadMs')::bigint, 0)
    into v_lead_ms from leagues where id = new.league_id;

  -- 0 = no clock-based deadline at all; the checks above are the deadline.
  if v_lead_ms > 0 and now() > v_sched - make_interval(secs => v_lead_ms / 1000.0) then
    raise exception 'Predictions for this match are locked (deadline passed).'
      using errcode = 'P0001';
  end if;
  return new;
end;
$function$;

-- Revealing everyone's picks has to move with it. Revealing on the scheduled
-- time while the match has not started would let a latecomer read the room and
-- then lock a copy of the best pick.
create or replace function public.get_match_predictions(p_league uuid, p_match text)
returns table(username text, pick text, score_a integer, score_b integer)
language sql
security definer
set search_path to 'public'
as $function$
  select m.username, p.pick, p.score_a, p.score_b
  from predictions p
  join league_members m
    on m.league_id = p.league_id and m.user_id = p.user_id
  where p.league_id = p_league
    and p.match_id  = p_match
    and p.locked = true
    and is_league_member(p_league, auth.uid())
    and (
      -- you already locked your own pick for this match
      exists (
        select 1 from predictions me
        where me.league_id = p_league and me.match_id = p_match
          and me.user_id = auth.uid() and me.locked = true
      )
      -- or the result is in
      or exists (select 1 from match_results mr where mr.match_id = p_match)
      -- or the match is under way
      or exists (
        select 1 from matches mt
        where mt.match_id = p_match and mt.status in ('live', 'completed')
      )
      -- or this league keeps a clock deadline and it has passed
      or exists (
        select 1 from matches mt
        cross join leagues l
        where mt.match_id = p_match and l.id = p_league
          and mt.scheduled_at is not null
          and coalesce((l.rules ->> 'lockLeadMs')::bigint, 0) > 0
          and now() > mt.scheduled_at
                      - make_interval(secs => (l.rules ->> 'lockLeadMs')::bigint / 1000.0)
      )
    );
$function$;

-- Existing leagues: open until the match starts.
update public.leagues
   set rules = jsonb_set(coalesce(rules, '{}'::jsonb), '{lockLeadMs}', '0'::jsonb)
 where coalesce((rules ->> 'lockLeadMs')::bigint, 0) <> 0;
