"""One source is not enough for finished games.

Run: python tools/test_results_fallback.py

WHY THIS EXISTS

OpenDota was the only source of FINISHED games this project ever had, and on
20 Aug 2026 - the day the TI playoffs started - it went down twice. HTTP 522
from its edge both times, its own /api/health reporting Postgres at 98.5% and
Cassandra at 98.8% of limit.

Measured at 07:26Z during the second outage: me-r1m2 had been played and
finished, and the site had no result for it. The bracket read "upcoming" 104
minutes after kickoff. The Valve fallback shipped earlier that morning covers
LIVE games only, so the rail worked and the results did not.

THE PART THAT IS EASY TO GET WRONG is the trigger. OpenDota answers 200 with an
EMPTY LIST when its own upstream is sick - it does not raise. A fallback wired
only to the exception path would have sat there doing nothing through both
outages, and every test of it would still have passed.

And it is not only a fallback. Valve's series ids are consistent where
OpenDota's are not: me-r1m1's two games came back from OpenDota with series_id
null and 1132142, so aggregate_series counted one game and the site published a
Bo3 as 0-1 - a score no Bo3 can end on. The REAL rows from Valve, inlined
below, roll up to 0-2.
"""
import io
import json
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


def row(mid, rad, dire, rad_win, start, sid, dur=2400):
    return {"match_id": mid, "radiant_name": rad, "dire_name": dire,
            "radiant_win": rad_win, "start_time": start, "duration": dur,
            "series_id": sid, "series_type": 1, "leagueid": 19719,
            "radiant_team_id": None, "dire_team_id": None,
            "radiant_score": None, "dire_score": None}


# The two games of me-r1m1 exactly as Valve returned them on 20 Aug.
ME_R1M1 = [
    row(8955197224, "Team Spirit", "Iron Wing", True, 1787193360, 1132142, 3720),
    row(8955247801, "Iron Wing", "Team Spirit", False, 1787199120, 1132142, 2640),
]


class Stub:
    """Swap the two network calls out, and count who was asked."""

    def __init__(self, od=None, od_raises=False, valve_payload=None, valve_raises=False):
        self.od, self.od_raises = od, od_raises
        self.valve_payload, self.valve_raises = valve_payload, valve_raises
        self.od_calls = self.valve_calls = 0

    def __enter__(self):
        self._real = (U.opendota_get, U.urllib.request.urlopen)

        def od(path):
            self.od_calls += 1
            if self.od_raises:
                raise RuntimeError("HTTP Error 522")
            return self.od

        def urlopen(req, timeout=None):
            self.valve_calls += 1
            if self.valve_raises:
                raise RuntimeError("connection reset")
            body = json.dumps(self.valve_payload).encode("utf-8")

            class R:
                def read(self_inner):
                    return body

                def __enter__(self_inner):
                    return self_inner

                def __exit__(self_inner, *a):
                    return False
            return R()

        U.opendota_get = od
        U.urllib.request.urlopen = urlopen
        return self

    def __exit__(self, *a):
        U.opendota_get, U.urllib.request.urlopen = self._real
        return False


print("THE TRIGGER: an EMPTY OpenDota answer, not just an exception")
# This is the whole point. OpenDota returns 200 + [] when its upstream is sick.
with Stub(od=[], valve_payload={"rows": ME_R1M1, "unnamed": 0}) as st:
    got = U.fetch_opendota_league_games(19719)
ok(len(got) == 2, "OpenDota returned [] -> Valve is asked", f"{len(got)} rows")
ok(st.valve_calls == 1, "and asked exactly once", str(st.valve_calls))

with Stub(od_raises=True, valve_payload={"rows": ME_R1M1, "unnamed": 0}) as st:
    got = U.fetch_opendota_league_games(19719)
ok(len(got) == 2, "OpenDota raised -> Valve is asked too", f"{len(got)} rows")

print("\nbut a working OpenDota is left alone")
od_rows = [row(1, "A", "B", True, 100, 5)]
with Stub(od=od_rows, valve_payload={"rows": ME_R1M1}) as st:
    got = U.fetch_opendota_league_games(19719)
ok(got == od_rows, "OpenDota's rows are returned unchanged", str(len(got)))
ok(st.valve_calls == 0, "and Valve is NOT called - no wasted round trip", str(st.valve_calls))

print("\nboth sources down is empty, not an exception")
# The updater must survive this: a crash here takes the whole run down,
# including the Liquipedia path that still works.
with Stub(od=[], valve_raises=True) as st:
    got = U.fetch_opendota_league_games(19719)
ok(got == [], "Valve unreachable -> []", str(got))
with Stub(od=[], valve_payload={"rows": None, "error": "Valve match history unavailable"}) as st:
    got = U.fetch_opendota_league_games(19719)
ok(got == [], "rows:null (Valve did not answer) -> []", str(got))
with Stub(od=[], valve_payload={"rows": []}) as st:
    got = U.fetch_opendota_league_games(19719)
ok(got == [], "rows:[] (Valve says no games) -> []", str(got))

print("\nTHE BUG THIS ALSO FIXES: me-r1m1 rolled up as 0-1")
# OpenDota shape: the SAME two games, but game one carries no series_id. That
# is what the site published on 20 Aug.
od_broken = [dict(ME_R1M1[0], series_id=None), dict(ME_R1M1[1])]
s_od = U.aggregate_series(od_broken, {})
by_pair = {(x["a"], x["b"]): x for x in s_od}
ok(len(s_od) == 2,
   "OpenDota's null series_id splits one Bo3 into two series", f"{len(s_od)} series")

s_valve = U.aggregate_series(ME_R1M1, {})
ok(len(s_valve) == 1, "Valve's consistent series_id keeps it as one", f"{len(s_valve)} series")
srs = s_valve[0]
score = {srs["a"]: srs["sa"], srs["b"]: srs["sb"]}
ok(score.get("Team Spirit") == 2 and score.get("Iron Wing") == 0,
   "and it rolls up to the true 2-0 for Team Spirit",
   f'{srs["a"]} {srs["sa"]}-{srs["sb"]} {srs["b"]}')
ok(len(srs["games"]) == 2, "with both games recorded", str(len(srs["games"])))

print("\nthe rows are shaped so aggregate_series can read them at all")
# aggregate_series reads radiant_name/dire_name first and falls back to a
# team_names map built from OpenDota's /leagues/{id}/teams - which is down at
# exactly the moment this runs. So the names must be ON the rows.
ok(all(r.get("radiant_name") and r.get("dire_name") for r in ME_R1M1),
   "every row carries both team names, with no team_names map needed", "")
named = U.aggregate_series(ME_R1M1, {})
ok(named and named[0]["a"] and named[0]["b"],
   "so a merge with an EMPTY team_names map still resolves", "")

print("\nthe endpoint is overridable, so this is testable without the network")
ok(hasattr(U, "VALVE_RESULTS_URL"), "VALVE_RESULTS_URL exists", "")
ok("valve-results" in U.VALVE_RESULTS_URL, "and points at the function", U.VALVE_RESULTS_URL)

print("\nTHE REPAIR: a healthy OpenDota with a HOLE in it")
# The fallback above only fires when OpenDota gives nothing. With OpenDota up
# and returning the 20 Aug rows verbatim, the site still publishes 0-1 - so the
# repair has to run on the healthy path too.
import time as _time  # noqa: E402

recent = int(_time.time()) - 3600
od_hole = [dict(ME_R1M1[0], series_id=None, start_time=recent),
           dict(ME_R1M1[1], start_time=recent + 1800)]
valve_full = [dict(ME_R1M1[0], start_time=recent),
              dict(ME_R1M1[1], start_time=recent + 1800)]

with Stub(od=od_hole, valve_payload={"rows": valve_full, "unnamed": 0}) as st:
    got = U.fetch_opendota_league_games(19719)
ok(st.valve_calls == 1, "a missing series id on a recent game costs one Valve call",
   str(st.valve_calls))
ok(all(r.get("series_id") for r in got), "and every hole is filled",
   str([r.get("series_id") for r in got]))
rolled = U.aggregate_series(got, {})
ok(len(rolled) == 1, "so the Bo3 rolls up as ONE series", f"{len(rolled)} series")
if rolled:
    sc = {rolled[0]["a"]: rolled[0]["sa"], rolled[0]["b"]: rolled[0]["sb"]}
    ok(sc.get("Team Spirit") == 2, "at the true 2-0, not 0-1",
       f'{rolled[0]["a"]} {rolled[0]["sa"]}-{rolled[0]["sb"]} {rolled[0]["b"]}')

print("\nbut it does not go looking when there is nothing to fix")
with Stub(od=valve_full, valve_payload={"rows": valve_full}) as st:
    got = U.fetch_opendota_league_games(19719)
ok(st.valve_calls == 0, "every series id present -> no Valve call at all", str(st.valve_calls))

old_hole = [dict(ME_R1M1[0], series_id=None, start_time=1787000000)]
with Stub(od=old_hole, valve_payload={"rows": valve_full}) as st:
    got = U.fetch_opendota_league_games(19719)
ok(st.valve_calls == 0, "and settled history is never rewritten", str(st.valve_calls))

print("\nan id OpenDota DID supply is left alone")
# Disagreeing with a value is a much bigger decision than filling a hole.
od_diff = [dict(ME_R1M1[0], series_id=999999, start_time=recent)]
with Stub(od=od_diff, valve_payload={"rows": valve_full}) as st:
    got = U.fetch_opendota_league_games(19719)
ok(got[0]["series_id"] == 999999, "OpenDota's own id survives", str(got[0]["series_id"]))

print("\nand a repair that fails cannot take the run down")
with Stub(od=od_hole, valve_raises=True) as st:
    got = U.fetch_opendota_league_games(19719)
ok(len(got) == 2, "Valve unreachable -> the OpenDota rows are still returned", str(len(got)))

print()
print(f"{fail} FAILURE(S)" if fail else "all good")
sys.exit(1 if fail else 0)
