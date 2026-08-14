-- Three holes in team_norm(), found by an independent QA pass over 0020.
--
-- 1. ACCENTS UNDER-MERGED — the exact bug class 0020 exists to kill.
--    Everything outside [a-z0-9 ] was turned into a space, so an accented
--    letter was deleted rather than folded:
--        team_norm('Türkiye') = 'trkiye'   team_norm('Turkiye') = 'turkiye'
--    Those do not match. `Türkiye` is real and already in team_ratings. Today it
--    only costs a missed upset-bonus lookup, but the moment an updater swaps the
--    accented spelling for the ASCII one on a team that is playing, a locked
--    pick flips — which is precisely what 0020 was written to prevent.
--    Fold the accents to their base letter first. Done with translate() rather
--    than the unaccent extension because unaccent() is only STABLE (it depends
--    on a dictionary file) and this function must stay IMMUTABLE.
--
-- 2. NULL STOPPED PROPAGATING. The internal coalesce turned NULL into '', so
--    team_norm(NULL) = team_norm(anything-that-strips-to-nothing) was TRUE.
--    Under the old scoring a NULL made is_correct NULL; here it made it false,
--    and `negativePoints` reads that difference — "Calm Dota Boys" has that rule
--    switched on. Nothing is exposed today (no null picks, no null winners) but
--    a null must never look like a match.
--
-- 3. NAMES MADE ONLY OF ORG WORDS COLLAPSED TO ''. team_norm('The Team') = ''
--    too, so it collided with NULL and with every other such name. Keep the
--    stripping, but fall back to the undecorated original when it would leave
--    nothing behind.

create or replace function public.team_norm(p_name text)
returns text
language sql
immutable
as $$
  select case
           -- NULL in, NULL out: a missing name matches nothing, not everything.
           when p_name is null then null
           -- Pairs no rule can derive, because the two spellings share no stem.
           -- Matched AFTER stripping, so "BetBoom Team" arrives as 'betboom'.
           -- Verified by roster, not guesswork: the BoomBoys carry in match
           -- 8944475901 is Kiritych~, the first player listed under BetBoom Team.
           when stripped = 'betboom' then 'boomboys'
           -- Stripping the org words left nothing at all ("The Team", "Gaming").
           -- Keep the whole name instead, or every such team becomes the same team.
           when stripped = ''       then bare
           else stripped
         end
  from (
    select
      regexp_replace(
        regexp_replace(folded, '\y(gaming|esports|esport|e sports|club|team|the|ti|20[0-9]{2})\y', ' ', 'g'),
        '\s+', '', 'g')                                   as stripped,
      regexp_replace(folded, '\s+', '', 'g')              as bare
    from (
      select regexp_replace(
               lower(translate(coalesce(p_name, ''),
                 -- Latin, Turkish and Polish letters folded to their base form.
                 -- Written as Unicode escapes so the file stays pure ASCII: the
                 -- first attempt used the accented characters literally and they
                 -- arrived misaligned, folding Turkiye's u-umlaut to 'a'.
                 U&'\00c0\00c1\00c2\00c3\00c4\00c5\00e0\00e1\00e2\00e3\00e4\00e5\00c8\00c9\00ca\00cb\00e8\00e9\00ea\00eb\00cc\00cd\00ce\00cf\00ec\00ed\00ee\00ef\00d2\00d3\00d4\00d5\00d6\00d8\00f2\00f3\00f4\00f5\00f6\00f8\00d9\00da\00db\00dc\00f9\00fa\00fb\00fc\00dd\00fd\00ff\00d1\00f1\00c7\00e7\0160\0161\017d\017e\0178\00d0\00f0\00de\00fe\0104\0105\0106\0107\0118\0119\0141\0142\0143\0144\015a\015b\0179\017a\017b\017c\0130\0131\011e\011f\015e\015f\0152\0153\00df',
                 'AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOOooooooUUUUuuuuYyyNnCcSsZzYDdTtAaCcEeLlNnSsZzZzIiGgSsOos')),
               '[^a-z0-9 ]', ' ', 'g') as folded
    ) f
  ) x;
$$;

comment on function public.team_norm(text) is
  'Canonical form of a team name for comparison. A rename such as Aurora -> Aurora Gaming, or an accented spelling swapped for its ASCII form, must not change a scoring verdict. NULL in, NULL out.';

-- The drift detector is the safety net for all of this, and it was readable
-- only by an admin connection — service_role had TRUNCATE and TRIGGER but not
-- SELECT, so any monitoring using the service key would have failed rather than
-- reported. Read for service_role only; it deliberately bypasses RLS, so anon
-- and authenticated stay out.
grant select on public.prediction_name_drift to service_role;
