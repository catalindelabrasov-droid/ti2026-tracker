-- Move the hourly full run onto pg_cron too.
--
-- The quarter-hour scoring pass moved first (0017) and measured 1 second from
-- timer to job start, against a GitHub scheduler that had been dropping whole
-- slots. There is no reason for the hourly run to keep depending on the
-- unreliable half of that pair, so the workflow's own `schedule:` is removed in
-- the same change and pg_cron becomes the only clock.
--
-- The watchdog stays as the safety net, now at a 45-minute threshold instead of
-- 75: with dispatch happening on the minute, lateness no longer exists, so data
-- older than 45 minutes means something is actually broken.

select cron.schedule(
  'full-tick',
  '0 * * * *',
  $$
  select net.http_post(
    url     := 'https://hqpynfzatnmwvlxdfhsw.supabase.co/functions/v1/updater-watchdog?full=1',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-tick-secret', (select value #>> '{}' from public.app_config where key = 'push_tick_secret')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 25000);
  $$
);
