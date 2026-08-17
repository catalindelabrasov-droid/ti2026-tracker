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
than six hours away.

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

print("\nit must NOT refuse anything real")
past = U._build_match("gs-r1-m1", block("Team Falcons", "LGD Gaming", 2, 1, iso(-72)), None, 3, {})
ok(past["status"] == "completed" and past["teamA"]["score"] == 2,
   "a group match played three days ago still settles",
   f'{past["status"]} {past["teamA"]["score"]}-{past["teamB"]["score"]}')

live = U._build_match("gs-r5-m1", block("A", "B", 1, 0, iso(-0.5), finished=False), None, 3, {})
ok(live["status"] in ("live", "completed") and live["teamA"]["score"] == 1,
   "a match that began half an hour ago is untouched", live["status"])

early = U._build_match("gs-r5-m2", block("A", "B", 2, 0, iso(1.5)), None, 3, {})
ok(early["status"] == "completed",
   "a match starting 90 min from now but already reported finished is ALLOWED "
   "- real fixtures do start early and the schedule is often stale", early["status"])

edge = U._build_match("edge", block("A", "B", 2, 0, iso(5.9)), None, 3, {})
ok(edge["status"] == "completed", "5.9h ahead: inside the window, allowed", edge["status"])
edge2 = U._build_match("edge2", block("A", "B", 2, 0, iso(6.5)), None, 3, {})
ok(edge2["status"] == "upcoming", "6.5h ahead: outside the window, refused", edge2["status"])

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
