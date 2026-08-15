"""A stray space in an upstream team name must not hide a whole team.

Run: python tools/test_team_name_whitespace.py

WHY THIS EXISTS

OpenDota returns radiant_team_name: null for every row in league 19719, so
aggregate_series() falls back to the name from /leagues/{id}/teams. That list
spells team 10136357 as 'Nigma Galaxy ' — with a trailing space, the only one of
the sixteen with stray whitespace.

The .strip() was bound to the per-game name only, not to the fallback, while
_match_key() stripped both. So the keys never met:

    data.json  ->  'nigma galaxy|team spirit'
    opendota   ->  'nigma galaxy |team spirit'

Every Nigma fixture was invisible to the merge. Not just cosmetic: the merge is
what promotes a fixture to live/completed when Liquipedia lags, which is what the
prediction lock leans on, and what makes collect_completed_results write a
match_results row at all. Nigma finished 2nd and go straight to the playoffs, so
without this their playoff matches would carry no game rows and might never
score anyone's picks.

Nothing failed. The team simply wasn't there.

KNOWN EQUIVALENT MUTANT: removing the .strip() from the key in
build_series_pair_map does not fail this file, and should not. aggregate_series
now cleans the name at source, so by the time the key is built there is nothing
left to strip. It is kept as defence for the next upstream that hands us a
name we did not sanitise — not as behaviour this file can observe.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import update_data as U   # noqa: E402

fail = 0


def ok(cond, msg, extra=""):
    global fail
    print(("  ok   " if cond else "  FAIL ") + msg + (("   " + extra) if extra else ""))
    if not cond:
        fail += 1


# The exact shape OpenDota serves for this league: no per-game names, so the
# fallback is the only source, and one of the two carries a trailing space.
TEAM_NAMES = {10136357: "Nigma Galaxy ", 7119388: "Team Spirit"}
ROWS = [
    {"match_id": 1, "series_id": 900, "series_type": 1,
     "radiant_team_id": 10136357, "dire_team_id": 7119388,
     "radiant_team_name": None, "dire_team_name": None,
     "start_time": 1786798574, "duration": 2000, "radiant_win": True},
    {"match_id": 2, "series_id": 900, "series_type": 1,
     "radiant_team_id": 10136357, "dire_team_id": 7119388,
     "radiant_team_name": None, "dire_team_name": None,
     "start_time": 1786801574, "duration": 2100, "radiant_win": True},
]

print("the upstream name really does carry a space")
ok(TEAM_NAMES[10136357] != TEAM_NAMES[10136357].strip(),
   "the fixture used here reproduces the real defect",
   repr(TEAM_NAMES[10136357]))

print("\nthe two key builders agree")
pair = U.build_series_pair_map([dict(r) for r in ROWS], TEAM_NAMES)
keys = list(pair.keys())
ok(len(keys) == 1, "one series pair was aggregated", str(keys))

want = U._match_key("Nigma Galaxy", "Team Spirit")
ok(keys and keys[0] == want,
   "the OpenDota key matches the key data.json produces",
   f"opendota={keys[0]!r} data={want!r}" if keys else "no key at all")

print("\nand the games actually reach it")
if keys:
    series = pair[keys[0]]
    ok(len(series) == 1, "the two games aggregated into one series", str(len(series)))
    s = series[0]
    ok(s["sa"] + s["sb"] == 2, "both games counted", f"{s['sa']}-{s['sb']}")
    ok(len(s.get("games") or []) == 2, "both game rows carried through",
       str(len(s.get("games") or [])))
    ok(s["a"].strip() == s["a"] and s["b"].strip() == s["b"],
       "the stored names are clean too", f"{s['a']!r} / {s['b']!r}")

print("\nno other whitespace shape slips through")
for raw, label in [("  Leading", "leading space"), ("Trailing  ", "trailing spaces"),
                   ("\tTabbed\t", "tabs"), ("Nigma Galaxy ", "non-breaking space")]:
    p = U.build_series_pair_map(
        [dict(ROWS[0])], {10136357: raw, 7119388: "Team Spirit"})
    k = list(p.keys())
    clean = k and k[0] == U._match_key(raw, "Team Spirit")
    ok(clean, f"{label}: the two builders still agree", (k[0] if k else "no key"))

print("\nan empty name is still rejected rather than keyed as blank")
p = U.build_series_pair_map([dict(ROWS[0])], {10136357: "   ", 7119388: "Team Spirit"})
ok(list(p.keys()) == [], "a whitespace-only name produces no series", str(list(p.keys())))

print()
print(f"{fail} FAILURE(S)" if fail else "all good")
sys.exit(1 if fail else 0)
