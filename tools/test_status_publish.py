"""A fixture that has kicked off must reach the SITE, not just the database.

Run: python tools/test_status_publish.py

WHY THIS EXISTS

The bracket on the page is read from data.json. Until 20 Aug 2026 the
quarter-hourly fast pass never rewrote that file: _pairing_snapshot carries only
(teamA, teamB, scheduled), so a flip to 'live' reached Supabase - closing the
prediction lock - but did not reach the published site until the next hourly
run.

Measured that morning, during the first playoff quarterfinal: me-r1m2 had been
under way for 28 minutes and the site still showed 'upcoming'. All fourteen
playoff fixtures would have done the same, for up to an hour each.

The fix publishes on a FORWARD status move. The forward-only part is not a
detail - it is what stops the fix costing more than the bug. _build_match
refuses a result reported too far before kickoff and resets a fixture to
'upcoming'; the OpenDota merge can set it back to 'live' on the same run. A
fixture caught between the two would flap every fifteen minutes, and each flap
is a commit, a Netlify deploy and 15 credits. That balance ran dry once already
this tournament and froze a corrupted data.json on the live site for six hours.
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


def doc(**statuses):
    """A data.json-shaped document with the given fixture statuses."""
    mk = lambda mid, st: {"id": mid, "status": st,
                          "teamA": {"name": "A", "score": None},
                          "teamB": {"name": "B", "score": None}}
    items = list(statuses.items())
    return {
        "meta": {},
        "groupStage": {"rounds": [{"name": "R", "matches":
                       [mk(k, v) for k, v in items[:1]]}],
                       "eliminationMatches": []},
        "bracket": {"rounds": {"upper": [{"name": "U", "matches":
                    [mk(k, v) for k, v in items[1:2]]}], "lower": []},
                    "grandFinal": mk(items[2][0], items[2][1]) if len(items) > 2 else None},
    }


print("the snapshot sees every fixture, in all three places it can live")
snap = U._status_snapshot(doc(**{"gs-r1-m1": "completed", "me-r1m1": "live", "me-r5m1": "upcoming"}))
ok(snap == {"gs-r1-m1": "completed", "me-r1m1": "live", "me-r5m1": "upcoming"},
   "group round, bracket round and grand final are all covered", str(snap))

print("\nthe incident: a fixture kicks off and must publish immediately")
before = {"me-r1m2": "upcoming"}
ok(U._status_advances(before, {"me-r1m2": "live"}) == ["me-r1m2"],
   "upcoming -> live publishes", "")
ok(U._status_advances({"me-r1m2": "live"}, {"me-r1m2": "completed"}) == ["me-r1m2"],
   "live -> completed publishes", "")
ok(U._status_advances(before, {"me-r1m2": "completed"}) == ["me-r1m2"],
   "upcoming -> completed (a fast series) publishes", "")

print("\nTHE FLAP GUARD - this is the one that protects the credit balance")
# _build_match refuses a too-early result and resets to 'upcoming'; the OpenDota
# merge can set it back to 'live' the same run. Publishing both directions turns
# that into 96 deploys a day.
ok(U._status_advances({"me-r1m2": "live"}, {"me-r1m2": "upcoming"}) == [],
   "live -> upcoming does NOT publish", "")
ok(U._status_advances({"me-r1m2": "completed"}, {"me-r1m2": "upcoming"}) == [],
   "completed -> upcoming does NOT publish", "")
ok(U._status_advances({"me-r1m2": "completed"}, {"me-r1m2": "live"}) == [],
   "completed -> live does NOT publish", "")

# A full flap cycle must cost exactly ONE publish, not one per swing.
cycle = [("upcoming", "live"), ("live", "upcoming"), ("upcoming", "live"),
         ("live", "upcoming"), ("upcoming", "live")]
publishes = sum(1 for b, a in cycle
                if U._status_advances({"x": b}, {"x": a}))
ok(publishes == 3, "a 5-swing flap still publishes only on the forward moves",
   f"{publishes} publishes for {len(cycle)} swings")

print("\nnothing else republishes the file")
ok(U._status_advances({"m": "live"}, {"m": "live"}) == [],
   "an unchanged status publishes nothing", "")
ok(U._status_advances({}, {}) == [], "an empty document publishes nothing", "")

print("\na fixture appearing for the first time counts as forward")
# A newly drawn bracket fixture has no previous status at all. It must publish,
# because that is the pairing people are waiting on to make a prediction.
ok(U._status_advances({}, {"me-r2m1": "upcoming"}) == ["me-r2m1"],
   "a brand new fixture publishes", "")
ok(U._status_advances({}, {"me-r2m1": "live"}) == ["me-r2m1"],
   "and so does one that appears already under way", "")

print("\nan unknown status is never treated as progress")
# Defensive: a typo or a new status from upstream must not start a flap.
ok(U._status_advances({"m": "completed"}, {"m": "postponed"}) == [],
   "completed -> unknown does not publish", "")
ok(U._status_advances({"m": "postponed"}, {"m": "live"}) == ["m"],
   "unknown -> live does publish, it is real progress", "")

print("\nthe ranking itself, stated so a reorder is a visible edit")
ok(U._STATUS_RANK["upcoming"] < U._STATUS_RANK["live"] < U._STATUS_RANK["completed"],
   "upcoming < live < completed", str(U._STATUS_RANK))

print("\nAND run_fast ACTUALLY CALLS IT - the call site, not just the function")
# The previous audit of this repo found five separate helpers that were tested
# in isolation while nothing proved the caller passed them anything. Deleting
# `or advanced` from run_fast leaves every assertion above green, so this drives
# run_fast end to end with the network stubbed out and watches for save().
saved = []
real = (U.update_stages_from_liquipedia, U.run_opendota, U.push_league_backend, U.save)


def _run(before_status, after_status):
    """One fast pass where the only thing that changes is a fixture's status."""
    del saved[:]
    data = doc(**{"gs-r1-m1": "completed", "me-r1m2": before_status,
                  "me-r5m1": "upcoming"})

    def flip(d):
        for r in d["bracket"]["rounds"]["upper"]:
            for m in r["matches"]:
                if m["id"] == "me-r1m2":
                    m["status"] = after_status

    U.update_stages_from_liquipedia = flip
    U.run_opendota = lambda d, main_only=False: (0, 0)
    U.push_league_backend = lambda d, with_ranking=True: None
    U.save = lambda d: saved.append(d)
    try:
        U.run_fast(data)
    finally:
        (U.update_stages_from_liquipedia, U.run_opendota,
         U.push_league_backend, U.save) = real
    return len(saved)


ok(_run("upcoming", "live") == 1,
   "a kick-off during the fast pass writes data.json", "")
ok(_run("live", "completed") == 1,
   "and so does the final whistle", "")
ok(_run("live", "upcoming") == 0,
   "a REGRESSION during the fast pass writes nothing", "")
ok(_run("live", "live") == 0,
   "an unchanged status writes nothing", "")

print("\nand the published file carries the new status, not the old one")
_run("upcoming", "live")
got = U._status_snapshot(saved[0]).get("me-r1m2") if saved else None
ok(got == "live", "the document handed to save() says 'live'", str(got))

print("\nA CORRECTION to an already-finished score must publish too")
# The third and last way data.json can be wrong on screen. me-r1m1 published as
# Iron Wing 0-1 Team Spirit - a score no Bo3 can end on - and the repair from
# Valve fixed the number on the next quarter-hour pass while the SITE stayed
# wrong, because a score change on a completed match is neither a new pairing
# nor a forward status move.
ok(U._score_corrections({"m": (0, 1)}, {"m": (0, 2)}) == ["m"],
   "0-1 -> 0-2 on a finished match publishes", "")
ok(U._score_corrections({"m": (0, 2)}, {"m": (0, 2)}) == [],
   "an unchanged finished score does not", "")

# Reaching 'completed' for the first time is NOT a correction: the status move
# already published it, and double-counting would mean two commits per match.
ok(U._score_corrections({}, {"m": (2, 0)}) == [],
   "a fixture finishing for the first time is not a correction", "")

# Live scores must stay out. The page merges those from the feed every 30s;
# publishing them would be ~96 commits and deploys a day.
live_doc = doc(**{"gs-r1-m1": "live", "me-r1m1": "completed", "me-r5m1": "upcoming"})
snap = U._final_scores(live_doc)
ok(list(snap.keys()) == ["me-r1m1"],
   "only COMPLETED fixtures are snapshotted", str(list(snap.keys())))

print("\nand the shared fixture walk reaches the grand final")
# It lives beside the rounds, not in them. A walk that forgets it silently
# stops publishing the one match everybody is waiting for.
allf = U._all_fixtures(doc(**{"gs-r1-m1": "completed", "me-r1m1": "completed",
                              "me-r5m1": "completed"}))
ok(set(allf) == {"gs-r1-m1", "me-r1m1", "me-r5m1"},
   "group round, bracket round and grand final", str(sorted(allf)))
ok(set(U._final_scores(doc(**{"gs-r1-m1": "completed", "me-r1m1": "completed",
                              "me-r5m1": "completed"}))) == set(allf),
   "and the score snapshot covers exactly the same set", "")

print("\nrun_fast publishes on a correction - the call site, again")
saved2 = []
real2 = (U.update_stages_from_liquipedia, U.run_opendota, U.push_league_backend, U.save)


def _run_correction(before_score, after_score):
    del saved2[:]
    data = doc(**{"gs-r1-m1": "completed", "me-r1m2": "completed", "me-r5m1": "upcoming"})
    for r in data["bracket"]["rounds"]["upper"]:
        for m in r["matches"]:
            if m["id"] == "me-r1m2":
                m["teamA"]["score"], m["teamB"]["score"] = before_score

    def fix(d):
        for r in d["bracket"]["rounds"]["upper"]:
            for m in r["matches"]:
                if m["id"] == "me-r1m2":
                    m["teamA"]["score"], m["teamB"]["score"] = after_score

    U.update_stages_from_liquipedia = fix
    U.run_opendota = lambda d, main_only=False: (0, 0)
    U.push_league_backend = lambda d, with_ranking=True: None
    U.save = lambda d: saved2.append(d)
    try:
        U.run_fast(data)
    finally:
        (U.update_stages_from_liquipedia, U.run_opendota,
         U.push_league_backend, U.save) = real2
    return len(saved2)


ok(_run_correction((0, 1), (0, 2)) == 1,
   "the real me-r1m1 case: 0-1 corrected to 0-2 writes data.json", "")
ok(_run_correction((0, 2), (0, 2)) == 0,
   "and an unchanged score still writes nothing", "")

print()
print(f"{fail} FAILURE(S)" if fail else "all good")
sys.exit(1 if fail else 0)
