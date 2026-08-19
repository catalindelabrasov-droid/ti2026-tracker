"""A match that has not started cannot have a result.

Run: python tools/test_no_future_results.py

WHY THIS EXISTS

On 16 Aug 2026 the 16:01Z auto-update ingested the whole TI playoff bracket as
finished - fourteen fixtures plus a grand final reading "TEAM VISION 3-2 Team
Liquid" - for matches scheduled 20-23 Aug. The consequences were not cosmetic:

  * the site announced a champion four days early
  * push_league_backend set fourteen matches.status to 'completed', and the
    prediction lock closes on that, so nobody could pick the playoffs
  * collect_completed_results wrote match_results rows, settling real people's
    predictions against outcomes that had not happened

The upstream cause was never knowable from our side. The clock is, so the guard
in _build_match refuses any completed/live result whose kickoff is still more
than LIQUIPEDIA_WRITE_GRACE_SEC away.

That bound was six hours until 19 Aug, which made it a WINDOW rather than a
wall: every fixture was unguarded for the six hours before it played, and in a
playoff week that is exactly the fixture worth faking. It is now one hour. The
assertions below are bound to the behaviour, not to the number, so restoring
6 * 3600 - or pointing _build_match at FUTURE_RESULT_GRACE_SEC, which is a
DIFFERENT constant on a different path - turns this file red.

THE FIXTURES BELOW ARE THE REAL ONES. Match ids, team names, scores and
scheduled times are taken from the corrupted data.json at commit 64f57da1.
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


def iso(hours_from_now):
    """A date in the format Liquipedia actually writes, NOT ISO.

    First draft of this file used datetime.isoformat() and every guard
    assertion failed - not because the guard was wrong but because
    _liqui_date_to_iso only accepts "%B %d, %Y %H:%M" / "%Y-%m-%d %H:%M" and
    friends, so date_iso came back None and there was nothing to judge. Worth
    keeping in mind: an unparseable date means the guard cannot fire at all.
    """
    d = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=hours_from_now)
    return d.strftime("%Y-%m-%d %H:%M")


def iso_prev(hours_from_now):
    """The same instant as data.json stores it - already ISO with an offset."""
    d = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=hours_from_now)
    return d.replace(microsecond=0).isoformat()


def block(a, b, sa, sb, when, finished=True):
    """Minimal wikitext Liquipedia would produce for a finished Bo3."""
    return (
        "|opponent1={{TeamOpponent|%s|score=%d}}"
        "|opponent2={{TeamOpponent|%s|score=%d}}"
        "|date=%s|finished=%s"
        % (a, sa, b, sb, when, "true" if finished else "false")
    )


print("the real incident: the grand final, reported finished four days early")
m = U._build_match("me-r5m1", block("TEAM VISION", "Team Liquid", 3, 2, iso(96)), None, 5, {})
ok(m["status"] == "upcoming",
   "status is refused back to upcoming", m["status"])
ok(m["teamA"]["score"] is None and m["teamB"]["score"] is None,
   "and the fabricated 3-2 is discarded",
   f'{m["teamA"]["score"]}-{m["teamB"]["score"]}')
ok(m["teamA"]["name"] == "TEAM VISION" and m["teamB"]["name"] == "Team Liquid",
   "the PAIRING is kept - the bracket shape is still real", "")

print("\nevery one of the fourteen playoff fixtures, as they were corrupted")
REAL = [
    ("me-r1m1", "Iron Wing", "Team Spirit", 2, 1), ("me-r1m2", "TEAM VISION", "BoomBoys", 2, 0),
    ("me-r1m3", "Team Liquid", "Team Yandex", 2, 1), ("me-r1m4", "Nigma Galaxy", "Team Falcons", 2, 1),
    ("me-r1m5", "Team Spirit", "BoomBoys", 2, 1), ("me-r2m1", "Iron Wing", "TEAM VISION", 1, 2),
    ("me-r2m2", "Team Liquid", "Nigma Galaxy", 2, 1), ("me-r3m1", "Nigma Galaxy", "Team Spirit", 2, 1),
    ("me-r4m1", "TEAM VISION", "Team Liquid", 2, 1), ("me-r4m2", "Nigma Galaxy", "Iron Wing", 1, 2),
]
refused = sum(
    1 for mid, a, b, sa, sb in REAL
    if U._build_match(mid, block(a, b, sa, sb, iso(96)), None, 3, {})["status"] == "upcoming")
ok(refused == len(REAL), f"all {len(REAL)} are refused", f"{refused}/{len(REAL)}")

print("\n'live' must be refused too, not just 'completed'")
# enforce_prediction_lock refuses a pick on status IN ('live','completed'), so
# half the incident's damage - "nobody could pick the playoffs" - arrives
# through 'live'. Narrowing the guard to == "completed" survived every test in
# the suite until this assertion existed; an adversarial review found it.
future_live = U._build_match(
    "me-r5m1", block("TEAM VISION", "Team Liquid", 1, 1, iso(96), finished=False), None, 5, {})
ok(future_live["status"] == "upcoming",
   "an unclinched 1-1 on a match 96h away is refused, not left 'live'",
   future_live["status"])
ok(future_live["teamA"]["score"] is None,
   "and its scores are discarded as well", str(future_live["teamA"]["score"]))

print("\nit must NOT refuse anything real")
past = U._build_match("gs-r1-m1", block("Team Falcons", "LGD Gaming", 2, 1, iso(-72)), None, 3, {})
ok(past["status"] == "completed" and past["teamA"]["score"] == 2,
   "a group match played three days ago still settles",
   f'{past["status"]} {past["teamA"]["score"]}-{past["teamB"]["score"]}')

live = U._build_match("gs-r5-m1", block("A", "B", 1, 0, iso(-0.5), finished=False), None, 3, {})
ok(live["status"] in ("live", "completed") and live["teamA"]["score"] == 1,
   "a match that began half an hour ago is untouched", live["status"])

grace = U._build_match("gs-r5-m2", block("A", "B", 2, 0, iso(0.75)), None, 3, {})
ok(grace["status"] == "completed",
   "a match starting 45 min from now but already reported finished is ALLOWED "
   "- that is forty times the largest early start ever measured here",
   grace["status"])

flip = U._build_match("gs-r5-m4", block("A", "B", 1, 0, iso(0.2), finished=False), None, 3, {})
ok(flip["status"] == "live",
   "and a legitimate flip to 'live' 12 min before kickoff is not blocked",
   flip["status"])

print("\nthe window is ONE hour, not six")
# This section is the whole point of the 19 Aug change, and the two assertions
# below are the mutants it must catch:
#   restore `ahead > 6 * 3600` in _build_match          -> both go red
#   point _build_match at FUTURE_RESULT_GRACE_SEC (6h)  -> both go red
#
# The previous version of this file asserted the OPPOSITE of the first one -
# "a match starting 90 min from now but already reported finished is ALLOWED,
# real fixtures do start early and the schedule is often stale". That rationale
# was never measured here. It had already been measured next door, in migration
# 0026, over all 39 completed group matches: median +2 min, worst LATE +34 min,
# and started more than five minutes EARLY exactly 1 of 39 - that one a
# corrupted schedule row, not an early start. Early is the only direction this
# guard reacts to. Inverting a passing assertion looks exactly like cheating on
# a test, so the measurement is cited here rather than in a commit message.
#
# The cost is real and bounded: if Liquipedia publishes a result while its own
# published kickoff is still over an hour away (1 occurrence in 44, and it was
# a schedule rewrite), the score is delayed until the clock passes the stale
# time. A refusal is not a deletion - the next run retries in 15 minutes.
early = U._build_match("early", block("A", "B", 2, 0, iso(1.5)), None, 3, {})
ok(early["status"] == "upcoming",
   "90 min ahead and reported finished: REFUSED", early["status"])
ok(early["teamA"]["score"] is None, "and its score is discarded too",
   str(early["teamA"]["score"]))

edge = U._build_match("edge", block("A", "B", 2, 0, iso(5.9)), None, 3, {})
ok(edge["status"] == "upcoming",
   "5.9h ahead: refused - the six-hour version ALLOWED this one", edge["status"])

# The boundary itself, tight enough that the constant cannot drift quietly.
# Without this pair, LIQUIPEDIA_WRITE_GRACE_SEC could be set to anything from
# 45 to 90 minutes and the file stayed green - a mutation review set it to 89
# minutes and nothing noticed. These two narrow that to 54-66 min, and the
# value assertion below closes the rest.
near = U._build_match("near", block("A", "B", 2, 0, iso(0.9)), None, 3, {})
ok(near["status"] == "completed", "54 min ahead: still inside the grace", near["status"])
past = U._build_match("past", block("A", "B", 2, 0, iso(1.1)), None, 3, {})
ok(past["status"] == "upcoming", "66 min ahead: outside it", past["status"])
ok(U.LIQUIPEDIA_WRITE_GRACE_SEC == 3600,
   "and the constant is exactly one hour",
   str(U.LIQUIPEDIA_WRITE_GRACE_SEC))

print("\nbut the DELETION bound is deliberately still six hours")
# push_league_backend withdraws stored rows for fixtures that have not started.
# Refusing to write is cheap; deleting a real result is not. So the two bounds
# are separate constants on purpose - see the docstring on starts_too_far_ahead.
ok(U.starts_too_far_ahead(iso_prev(1.5)) is False,
   "a fixture 90 min out is NOT withdrawn, even though a write would be refused", "")
ok(U.starts_too_far_ahead(iso_prev(6.5)) is True,
   "6.5h out is still withdrawn", "")
ok(U.LIQUIPEDIA_WRITE_GRACE_SEC < U.FUTURE_RESULT_GRACE_SEC,
   "the write bound is tighter than the delete bound",
   f"{U.LIQUIPEDIA_WRITE_GRACE_SEC}s < {U.FUTURE_RESULT_GRACE_SEC}s")

print("\nno scheduled time means no basis to refuse")
nodate = U._build_match("nd", "|opponent1={{TeamOpponent|A|score=2}}"
                              "|opponent2={{TeamOpponent|B|score=0}}|finished=true", None, 3, {})
ok(nodate["status"] == "completed",
   "an undated finished match is left alone rather than guessed at", nodate["status"])

print("\nand a bogus result cannot sneak back in via the previous run")
prev = {"me-r5m1": {"id": "me-r5m1", "status": "completed", "scheduled": iso_prev(96),
                    "teamA": {"name": "TEAM VISION", "score": 3},
                    "teamB": {"name": "Team Liquid", "score": 2}}}
carried = U._build_match("me-r5m1", None, None, 5, prev)
ok(carried["status"] == "upcoming" and carried["teamA"]["score"] is None,
   "carry-forward from a poisoned data.json is refused too",
   f'{carried["status"]} {carried["teamA"]["score"]}-{carried["teamB"]["score"]}')

print()
print(f"{fail} FAILURE(S)" if fail else "all good")
sys.exit(1 if fail else 0)
