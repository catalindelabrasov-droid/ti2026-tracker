-- Close predictions when the match starts — using the CURRENT published time,
-- which moves when a match is delayed.
--
-- 0019 removed the clock rule entirely, for a good reason at the time: on
-- 13 Aug 2026 round two's fixtures sat 28 to 78 minutes past their published
-- start without having been played, and every one of them showed "Locking
-- deadline passed" — people were locked out of matches that had not begun.
--
-- But the replacement leans on matches.status, and that only advances when the
-- updater notices, which needs OpenDota to publish a finished GAME. During
-- game 1 the series score is still 0-0, so a match stays 'upcoming' for the
-- whole of it. Measured over the group stage: 18 predictions were locked in
-- after their match had physically started, the worst 67 minutes late, three of
-- them after a game had already been decided. That is enough to decide the
-- league — recomputing without those 18 changes who is first.
--
-- What has changed since 0019 is that we can now check whether the schedule is
-- actually trustworthy, rather than assuming. Across all 39 completed group
-- matches, comparing the published time to the real first-game start from
-- OpenDota:
--
--     median  +2 min      mean  0 min      worst late  +34 min
--     started more than 5 minutes EARLY: 1 of 39
--
-- and that single outlier (gs-r5-m2, -154 min) is a corrupted row, not drift —
-- it regressed from a correct value mid-afternoon. So the published time tracks
-- reality closely, and delays DO reach it: Liquipedia moves the time and the
-- updater upserts it every 15 minutes, which is what "the updated hour" means.
--
-- Five minutes of grace absorbs the ordinary jitter (the median is +2) without
-- reopening a meaningful window after the first game begins. The exposure drops
-- from up to 67 minutes to about 5.
--
-- The three existing rules are untouched and still fire first, so nothing here
-- can make a match MORE open than it was:
--   * a result exists                        -> closed
--   * status is live or completed            -> closed
--   * lockLeadMs > 0 and its deadline passed -> closed (leagues that want an
--                                               earlier, explicit cut-off)
--
-- Known limitation, stated rather than hidden: if a match is delayed and
-- Liquipedia does NOT republish the time, this closes predictions at the old
-- time and people lose the rest of the window. That is the 13 Aug failure mode.
-- The evidence above says it is now rare, and the direction of the error is the
-- safe one — an early close costs someone a pick, a late close lets someone
-- pick a result they have already seen. If it starts happening again, the real
-- fix is to make status advance from the live feed, which knows within seconds,
-- rather than from a finished game.

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

  -- The published start has passed. Delays move this value, so it is the
  -- "updated hour", not a deadline fixed in advance.
  if now() >= v_sched + interval '5 minutes' then
    raise exception 'This match has started - predictions are closed.'
      using errcode = 'P0001';
  end if;

  select coalesce((rules ->> 'lockLeadMs')::bigint, 0)
    into v_lead_ms from leagues where id = new.league_id;

  -- A league may still choose to close EARLIER than the start.
  if v_lead_ms > 0 and now() > v_sched - make_interval(secs => v_lead_ms / 1000.0) then
    raise exception 'Predictions for this match are locked (deadline passed).'
      using errcode = 'P0001';
  end if;
  return new;
end;
$function$;
