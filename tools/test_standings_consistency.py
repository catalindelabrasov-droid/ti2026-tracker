"""data.json must not contradict itself.

Run: python tools/test_standings_consistency.py

WHY THIS EXISTS

groupStage.standings is computed once, at Liquipedia parse time, from the rounds
as parsed. run_opendota() then merges newer scores into those same rounds and
flips series to "completed" — and nothing recomputed the array. save() wrote
fresh rounds beside stale standings.

Observed live on 2026-08-15: the published file said Aurora Gaming 2-1 and
BoomBoys 2-1 while its own rounds said 3-1 and 2-2.

It went unnoticed because renderGroups() recomputes W-L from the merged matches
and uses standings[] only to seed team names. The page repairs the file at
render time — the same shape as every other bug that survived here: correct on
screen, wrong underneath.
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

fail = 0


def ok(cond, msg, extra=""):
    global fail
    print(("  ok   " if cond else "  FAIL ") + msg + ("   " + extra if extra else ""))
    if not cond:
        fail += 1


with open(os.path.join(ROOT, "data.json"), encoding="utf-8") as fh:
    data = json.load(fh)

gs = data.get("groupStage") or {}
rounds = gs.get("rounds") or []
stored = gs.get("standings") or []

ok(bool(rounds), "data.json has group-stage rounds", str(len(rounds)))
ok(bool(stored), "data.json has a stored standings array", str(len(stored)))

# Rebuild from the rounds, the same way the page does.
rec = {}
for rd in rounds:
    for m in rd.get("matches") or []:
        if m.get("status") != "completed":
            continue
        a, b = m.get("teamA") or {}, m.get("teamB") or {}
        an, bn = a.get("name"), b.get("name")
        if not an or not bn or an == "TBD" or bn == "TBD":
            continue
        sa, sb = a.get("score"), b.get("score")
        if not isinstance(sa, int) or not isinstance(sb, int) or sa == sb:
            continue
        rec.setdefault(an, [0, 0])
        rec.setdefault(bn, [0, 0])
        if sa > sb:
            rec[an][0] += 1
            rec[bn][1] += 1
        else:
            rec[bn][0] += 1
            rec[an][1] += 1

ok(bool(rec), "rebuilt records from completed series", "%d teams" % len(rec))

mismatch = []
for row in stored:
    team = row.get("team")
    if team not in rec:
        continue
    w, ls = rec[team]
    if row.get("wins") != w or row.get("losses") != ls:
        mismatch.append("%s stored %s-%s vs rounds %d-%d"
                        % (team, row.get("wins"), row.get("losses"), w, ls))

ok(not mismatch,
   "stored standings agree with the rounds in the same file",
   "; ".join(mismatch))

# Every team in the rounds should appear in the stored array, and vice versa.
stored_names = {r.get("team") for r in stored}
missing = sorted(set(rec) - stored_names)
extra = sorted(stored_names - set(rec))
ok(not missing, "no team is missing from standings", ", ".join(missing))
ok(not extra, "standings names no team the rounds do not know", ", ".join(extra))

# Arithmetic sanity: total wins must equal total losses.
tw = sum(v[0] for v in rec.values())
tl = sum(v[1] for v in rec.values())
ok(tw == tl, "total wins equal total losses", "%d vs %d" % (tw, tl))

rounds_n = len(rounds)
over = ["%s %d-%d" % (t, v[0], v[1]) for t, v in rec.items() if v[0] + v[1] > rounds_n]
ok(not over, "no team has played more than %d rounds" % rounds_n, ", ".join(over))

print()
print("%d CHECK(S) FAILED" % fail if fail else "data.json is internally consistent")
sys.exit(1 if fail else 0)
