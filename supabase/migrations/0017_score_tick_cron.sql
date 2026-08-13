-- Drive the 15-minute scoring pass from pg_cron instead of GitHub's scheduler.
--
-- GitHub's `schedule` trigger is best-effort and gets deprioritised on public
-- repos. It dropped two consecutive hours on TI opening night, and both the
-- 07:00 and 07:15 slots on day two. Supabase's cron has not missed a beat
-- (0 failures across every check), and `workflow_dispatch` fires immediately,
-- so the reliable timer keeps the clock and GitHub only runs the job.
--
-- The quarter-hour offsets deliberately avoid :00, where the hourly full run
-- already fires — the workflow's concurrency group would queue them anyway, but
-- there is no reason to make it.

select cron.schedule(
  'score-tick',
  '15,30,45 * * * *',
  $$
  select net.http_post(
    url     := 'https://hqpynfzatnmwvlxdfhsw.supabase.co/functions/v1/updater-watchdog?fast=1',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-tick-secret', (select value #>> '{}' from public.app_config where key = 'push_tick_secret')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 25000);
  $$
);
