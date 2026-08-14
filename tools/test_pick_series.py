"""_pick_series: the disaster cases, the review's three bypasses, and every
path that must keep working."""
import sys, datetime
sys.path.insert(0, r"C:\Users\Azog\Desktop\ti2026-tracker")
import update_data as U

def ser(sid, sa, sb, start):
    return {"sid": sid, "a": "BoomBoys", "b": "OG", "sa": sa, "sb": sb,
            "start": start, "best_of": 3, "last": start + 3000, "games": []}

utc  = datetime.timezone.utc
ts   = lambda *a: int(datetime.datetime(*a, tzinfo=utc).timestamp())
iso  = lambda t: datetime.datetime.fromtimestamp(t, utc).isoformat()
AUG13, AUG21, AUG23 = ts(2026,8,13,10), ts(2026,8,21,10), ts(2026,8,23,20)
MAIN_EVENT = ts(2026,8,20)          # floor passed for bracket fixtures

swiss   = ser("S1", 2, 0, AUG13)
playoff = ser("S2", 1, 2, AUG21)

ok = fail = 0
def check(name, got, want):
    global ok, fail
    if got == want: ok += 1;  print(f"  PASS  {name}")
    else:           fail += 1; print(f"  FAIL  {name}\n          got {got!r}  want {want!r}")
sid = lambda s: s.get("sid") if s else None

print("-- the disaster: an unplayed playoff rematch must never inherit the Swiss result")
check("group fixture claims its own series",
      sid(U._pick_series([swiss], iso(AUG13), set())), "S1")
check("rematch refused once the group fixture claimed",
      U._pick_series([swiss], None, {"S1"}, MAIN_EVENT), None)

print("-- the review's three bypasses: the guard must hold even if nothing claimed")
check("group fixture was TBD, so nothing claimed -> floor still refuses",
      U._pick_series([swiss], None, set(), MAIN_EVENT), None)
check("group date was >36h out, so nothing claimed -> floor still refuses",
      U._pick_series([swiss], None, set(), MAIN_EVENT), None)
check("team spelled differently on the two pages -> floor still refuses",
      U._pick_series([swiss], None, set(), MAIN_EVENT), None)

print("-- but a genuinely played playoff series must resolve")
check("played rematch resolves", sid(U._pick_series([swiss, playoff], None, {"S1"}, MAIN_EVENT)), "S2")
check("played rematch resolves even if nothing was claimed",
      sid(U._pick_series([playoff], None, set(), MAIN_EVENT)), "S2")

print("-- no permanent refusal: a slipped/placeholder bracket date must still merge")
check("bracket dated 22nd, actually played 23rd (44h out) -> falls through and resolves",
      sid(U._pick_series([ser("S3",2,1,AUG23)], iso(ts(2026,8,22,0)), set(), MAIN_EVENT)), "S3")
check("...and the floor still applies on that fall-through",
      U._pick_series([swiss], iso(ts(2026,8,22,0)), set(), MAIN_EVENT), None)

print("-- rows with no start_time must not be stranded")
check("first-ever meeting, start=0, nothing claimed -> resolves",
      sid(U._pick_series([ser("S4",2,0,0)], None, set(), 0)), "S4")

print("-- ordinary paths unchanged")
check("scheduled group match resolves", sid(U._pick_series([swiss], iso(AUG13), set(), 0)), "S1")
check("two series, schedule picks the right one",
      sid(U._pick_series([swiss, playoff], iso(AUG21), set(), 0)), "S2")
check("ambiguous: two unclaimed, no schedule -> refuse", 
      U._pick_series([swiss, playoff], None, set(), 0), None)
check("older series cannot back-fill a later fixture",
      U._pick_series([swiss, playoff], None, {"S2"}, MAIN_EVENT), None)
check("no candidates", U._pick_series([], iso(AUG13), set()), None)
check("None candidates", U._pick_series(None, None, set()), None)
check("back-compat: no claimed, no floor", sid(U._pick_series([swiss], iso(AUG13))), "S1")

print("-- _stage_floor")
check("reads the Main Event date",
      U._stage_floor({"meta":{"dates":{"mainEvent":"2026-08-20 to 2026-08-23"}}}, "mainEvent"), MAIN_EVENT)
check("missing dates -> 0 (no floor, never blocks)", U._stage_floor({}, "mainEvent"), 0)
check("garbage date -> 0", U._stage_floor({"meta":{"dates":{"mainEvent":"TBD"}}}, "mainEvent"), 0)

print(f"\n  {ok} passed, {fail} failed")
sys.exit(1 if fail else 0)
