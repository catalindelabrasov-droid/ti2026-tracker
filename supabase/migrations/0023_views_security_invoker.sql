-- Make both public views run as the CALLER, not as their owner.
--
-- Supabase's Security Advisor flags this as CRITICAL, and the pattern deserves
-- the flag in general: a view created without `security_invoker` executes with
-- the owner's rights, so it reads straight past any row-level policy on the
-- tables underneath. Every restriction you wrote is simply not applied.
--
-- What it means HERE, checked rather than assumed:
--   ladder_standings selects from ladder_teams, whose SELECT policy is
--   `USING (true)` for `public` — the ladder is a leaderboard and is meant to
--   be world-readable. So the view was not actually revealing anything the
--   policy would have hidden, which is why nothing looked wrong. The severity
--   is in what it would cost LATER: the moment anyone tightens that policy,
--   this view would keep serving the old rows and nobody would notice.
--
--   prediction_name_drift is granted to service_role only, which bypasses RLS
--   anyway, so this changes nothing for it today either. Set it for the same
--   reason: the safe default should not depend on who happens to be granted.
--
-- Safe to apply: with the SELECT policy already `true` for public, anon reads
-- exactly the same rows before and after.

alter view public.ladder_standings      set (security_invoker = true);
alter view public.prediction_name_drift set (security_invoker = true);
