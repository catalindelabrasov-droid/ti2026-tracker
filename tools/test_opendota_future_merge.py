"""OpenDota must not decide a match that has not been played either.

Run: python tools/test_opendota_future_merge.py

WHY THIS EXISTS

The 17 Aug guard went into _build_match and its commit message claimed that was
the single chokepoint. It was not. merge_opendota_scores.apply() is a SECOND,
independent writer: it sets teamA/teamB scores and promotes status to
live/completed directly on the match dicts, and it runs AFTER the Liquipedia
parse. An adversarial review reproduced the ENTIRE incident through it with the
"fix" in place - a grand final decided 143 hours before kickoff, pushed through
to matches.status and match_results.

Worse, on the Liquipedia-outage branch update_stages_from_liquipedia is never
called at all, so _build_match never runs and this was the only writer.

The only thing that had ever stopped an OpenDota series landing on an unplayed
REMATCH was name-matching in _pick_series plus _stage_floor, which reads
meta.dates.mainEvent - one string in hand-maintained metadata that nothing in
update_data.py writes and no test asserted was present. Both had already failed
this tournament: "BetBoom Team" vs "BoomBoys", and the trailing space that hid
every Nigma Galaxy fixture.

So this file exists to hold merge_opendota_scores to its own clock check.

WHAT IT DOES *NOT* PROVE. An earlier version of this docstring said "both
writers now share one clock check, starts_too_far_ahead()". That was false and
it mattered: _build_match has always kept its own inline check, on its own
constant (LIQUIPEDIA_WRITE_GRACE_SEC, one hour since 19 Aug), and this file
never touches that path. Anyone reading only this file and then tightening
FUTURE_RESULT_GRACE_SEC would leave the Liquipedia parser - the writer that
actually fabricated the bracket - exactly as it was. The Liquipedia side is
covered by tools/test_no_future_results.py, separately. Unifying the two is a
post-event job and needs a test that fails when either is mutated alone.
"""
import datetime
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


def at(hours):
    d = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=hours)
    return d.replace(microsecond=0).isoformat()


def fixture(mid, a, b, when, best=3):
    return {"id": mid, "bestOf": best, "status": "upcoming", "scheduled": when,
            "teamA": {"name": a, "score": None}, "teamB": {"name": b, "score": None}}


def series(a, b, sa, sb, sid, start):
    return {"a": a, "b": b, "sa": sa, "sb": sb, "sid": sid,
            "start": int(datetime.datetime.fromisoformat(start).timestamp()),
            "games": []}


def run(match, ser):
    """Push one series through merge_opendota_scores against one fixture."""
    data = {"meta": {}, "bracket": {"rounds": {"upper": [{"name": "R", "matches": [match]}]}}}
    U.merge_opendota_scores(data, {U._match_key(ser["a"], ser["b"]): [ser]})
    return match


print("the reproduction: a grand final decided 143 hours early")
gf = fixture("me-r5m1", "TEAM VISION", "Team Liquid", at(143), best=5)
run(gf, series("TEAM VISION", "Team Liquid", 3, 2, "S-FAKE", at(-24)))
ok(gf["status"] == "upcoming", "status stays upcoming", gf["status"])
ok(gf["teamA"]["score"] is None and gf["teamB"]["score"] is None,
   "no score is written", f'{gf["teamA"]["score"]}-{gf["teamB"]["score"]}')

print("\nand nothing reaches the league backend from it")
data = {"meta": {}, "bracket": {"rounds": {"upper": [{"name": "R", "matches": [gf]}]}},
        "groupStage": {}, "qualifiers": []}
ok(U.collect_completed_results(data) == [],
   "collect_completed_results yields nothing", str(U.collect_completed_results(data)))
pushed = [(r["match_id"], r["status"]) for r in U.collect_all_matches(data)]
ok(pushed == [("me-r5m1", "upcoming")],
   "collect_all_matches pushes 'upcoming', so the prediction lock stays OPEN",
   str(pushed))

print("\nthe 'live' half matters as much as 'completed'")
# enforce_prediction_lock refuses a pick on status IN ('live','completed'), so an
# unclinched series on a future fixture closes the window just as hard.
lv = fixture("me-r2m3", "Nigma Galaxy", "Team Spirit", at(119))
run(lv, series("Nigma Galaxy", "Team Spirit", 1, 1, "S-LIVE", at(-2)))
ok(lv["status"] == "upcoming",
   "an unclinched 1-1 does NOT flip a future fixture to live", lv["status"])

print("\nit must still merge everything real")
now_m = fixture("gs-r5-m1", "Team Spirit", "Nigma Galaxy", at(-2))
run(now_m, series("Team Spirit", "Nigma Galaxy", 2, 0, "S-REAL", at(-2)))
ok(now_m["status"] == "completed" and now_m["teamA"]["score"] == 2,
   "a match played two hours ago settles normally",
   f'{now_m["status"]} {now_m["teamA"]["score"]}-{now_m["teamB"]["score"]}')

live_m = fixture("gs-r5-m2", "OG", "BoomBoys", at(-0.5))
run(live_m, series("OG", "BoomBoys", 1, 0, "S-NOW", at(-0.5)))
ok(live_m["status"] == "live", "a match under way right now goes live", live_m["status"])

early = fixture("gs-r5-m3", "LGD Gaming", "Aurora", at(3))
run(early, series("LGD Gaming", "Aurora", 2, 1, "S-EARLY", at(-1)))
ok(early["status"] == "completed",
   "a fixture that started 3h before its published time still settles - schedules slip",
   early["status"])

print("\nthe OpenDota writer's own definition of 'too far ahead'")
ok(U.starts_too_far_ahead(at(96)) is True, "96h ahead -> refused", "")
ok(U.starts_too_far_ahead(at(5.9)) is False, "5.9h ahead -> allowed", "")
ok(U.starts_too_far_ahead(at(6.5)) is True, "6.5h ahead -> refused", "")
ok(U.starts_too_far_ahead(at(-100)) is False, "already played -> allowed", "")

print("\nan unreadable date fails OPEN, never closed")
# Failing closed here would discard real results - and since push_league_backend
# withdraws results for refused fixtures, it would DELETE them.
for bad in (None, "", "TBD", "not a date", "2026-13-45T99:99"):
    ok(U.starts_too_far_ahead(bad) is False,
       f"{bad!r} -> no basis to refuse", "")
ok(U.hours_until_start("garbage") is None, "hours_until_start reports None, not 0", "")

print("\na naive timestamp is read as UTC rather than crashing")
naive = (datetime.datetime.now(datetime.timezone.utc)
         + datetime.timedelta(hours=96)).replace(tzinfo=None).isoformat()
ok(U.starts_too_far_ahead(naive) is True,
   "a tz-less ISO string 96h out is still refused", naive)

print()
print(f"{fail} FAILURE(S)" if fail else "all good")
sys.exit(1 if fail else 0)
