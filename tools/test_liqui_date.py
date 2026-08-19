"""Liquipedia date strings must produce the offsets they say they do.

Run: python tools/test_liqui_date.py

WHY THIS EXISTS

_liqui_date_to_iso reads the timezone from {{Abbr/XXX}} and looks XXX up in
_TZ_OFFSETS. Two independent audits on 19 Aug 2026 found the same class of bug
from opposite directions, and it is the only finding that week with two-source
agreement:

  1. The offset regex demanded `}}` immediately after the abbreviation, while
     the stripper one line below removed the template either way. So
     {{Abbr/CST|China Standard Time}} - a form Liquipedia writes freely -
     parsed SUCCESSFULLY at UTC.
  2. The table held 17 of the 83 abbreviations Module:Timezone/Data defines.
     A missing one also resolves to UTC.

Neither failure is loud. Both produce a confident wrong answer, and eastward
that is the dangerous direction: a played match looks like it has not started,
so the write guard refuses the REAL result, and push_league_backend then
withdraws any row that had already landed. All fourteen TI playoff fixtures
carry {{Abbr/CST}}, and six other abbreviations share CST's +8 wall clock
(MYT PHT PHST TST BNT WITA ULAT), so a purely editorial switch between them
would have changed nothing a reader sees and broken everything downstream.

The golden block below is fourteen (wikitext -> ISO) pairs captured from the
live Main Event page and data.json on 19 Aug 2026. Read it for what it is: a
PURE-FUNCTION fixture. It pins the CST offset and the accepted date formats, and
it proved the 19 Aug regex and table changes moved nothing at the time.

It does NOT track data.json - this file never opens it. If Liquipedia reschedules
a fixture, and it did once already this tournament (gs-r5-m2 regressed by 154
minutes), these fourteen pairs stay internally consistent and stay green while
the site moves on. That is deliberate: pinning live times here would go red on a
legitimate reschedule and teach everyone to ignore the file. What must not drift
is the OFFSET, and the last block checks that against the real data.json by
reconstruction - which a reschedule cannot falsely break.
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


print("the fourteen live playoff fixtures parse to exactly what data.json holds")
GOLDEN = [
    ("me-r1m1", "August 20, 2026 - 10:00 {{Abbr/CST}}", "2026-08-20T10:00:00+08:00"),
    ("me-r1m2", "August 20, 2026 - 13:00 {{Abbr/CST}}", "2026-08-20T13:00:00+08:00"),
    ("me-r1m3", "August 20, 2026 - 16:00 {{Abbr/CST}}", "2026-08-20T16:00:00+08:00"),
    ("me-r1m4", "August 20, 2026 - 19:00 {{Abbr/CST}}", "2026-08-20T19:00:00+08:00"),
    ("me-r1m5", "August 21, 2026 - 10:00 {{Abbr/CST}}", "2026-08-21T10:00:00+08:00"),
    ("me-r1m6", "August 21, 2026 - 13:00 {{Abbr/CST}}", "2026-08-21T13:00:00+08:00"),
    ("me-r2m1", "August 21, 2026 - 16:00 {{Abbr/CST}}", "2026-08-21T16:00:00+08:00"),
    ("me-r2m2", "August 21, 2026 - 19:00 {{Abbr/CST}}", "2026-08-21T19:00:00+08:00"),
    ("me-r2m3", "August 22, 2026 - 13:00 {{Abbr/CST}}", "2026-08-22T13:00:00+08:00"),
    ("me-r2m4", "August 22, 2026 - 10:00 {{Abbr/CST}}", "2026-08-22T10:00:00+08:00"),
    ("me-r3m1", "August 22, 2026 - 19:00 {{Abbr/CST}}", "2026-08-22T19:00:00+08:00"),
    ("me-r4m1", "August 22, 2026 - 16:00 {{Abbr/CST}}", "2026-08-22T16:00:00+08:00"),
    ("me-r4m2", "August 23, 2026 - 10:00 {{Abbr/CST}}", "2026-08-23T10:00:00+08:00"),
    ("me-r5m1", "August 23, 2026 - 13:00 {{Abbr/CST}}", "2026-08-23T13:00:00+08:00"),
]
moved = [f'{mid}: {U._liqui_date_to_iso(raw)} != {want}'
         for mid, raw, want in GOLDEN if U._liqui_date_to_iso(raw) != want]
ok(not moved, f"all {len(GOLDEN)} unchanged", "; ".join(moved))

print("\nthe piped form of the template - the bug that was live")
ok(U._liqui_date_to_iso("August 20, 2026 - 10:00 {{Abbr/CST|China Standard Time}}")
   == "2026-08-20T10:00:00+08:00",
   "{{Abbr/CST|China Standard Time}} still reads as +08:00",
   str(U._liqui_date_to_iso("August 20, 2026 - 10:00 {{Abbr/CST|China Standard Time}}")))
ok(U._liqui_date_to_iso("August 20, 2026 - 10:00 {{ Abbr/CST }}")
   == "2026-08-20T10:00:00+08:00",
   "and so does a padded {{ Abbr/CST }}",
   str(U._liqui_date_to_iso("August 20, 2026 - 10:00 {{ Abbr/CST }}")))

print("\ncase, which the regex anticipates and the lookup must match")
# The regex is written [Aa]bbr precisely because Liquipedia writes the template
# name either way. The lookup then leans on .upper() to normalise what the
# capture group returns - and deleting that .upper() used to survive the whole
# suite. {{abbr/cst}} would resolve to UTC, all fourteen playoff fixtures would
# jump eight hours later, and the guard would refuse real results as "not
# started yet" while the withdrawal path deleted what had already landed.
#
# {{ABBR/...}} is deliberately NOT here: MediaWiki folds only the first letter
# of a template name, so that is a different template and failing to match it is
# correct.
for raw in ("{{abbr/CST}}", "{{Abbr/cst}}", "{{abbr/cst}}",
            "{{abbr/CST|China Standard Time}}"):
    got = U._liqui_date_to_iso("August 20, 2026 - 10:00 " + raw)
    ok(got == "2026-08-20T10:00:00+08:00", raw + " -> +08:00", str(got))

print("\nthe +8 neighbours an editor could switch to without a reader noticing")
for abbr in ("MYT", "PHT", "PHST", "TST", "BNT", "WITA", "ULAT", "SGT", "HKT"):
    got = U._liqui_date_to_iso("August 20, 2026 - 10:00 {{Abbr/%s}}" % abbr)
    ok(got == "2026-08-20T10:00:00+08:00", f"{{{{Abbr/{abbr}}}}} -> +08:00", str(got))

print("\na spread of the zones the old 17-entry table did not have")
for abbr, want in (("AEST", "+10:00"), ("NZST", "+12:00"), ("ICT", "+07:00"),
                   ("PKT", "+05:00"), ("CDT", "-05:00"), ("CT", "-06:00"),
                   ("MST", "-07:00"), ("BRT", "-03:00"), ("SAST", "+02:00")):
    got = U._liqui_date_to_iso("August 20, 2026 - 10:00 {{Abbr/%s}}" % abbr)
    ok(bool(got) and got.endswith(want), f"{{{{Abbr/{abbr}}}}} -> {want}", str(got))

print("\nthe half-hour zones are absent ON PURPOSE, not by oversight")
# This table stores whole hours. A rounded IST would be a quieter lie than an
# obvious fallback, and TI 2026 uses none of them. When the minutes-based table
# lands after the event, these assertions are what must be updated first.
for abbr in ("IST", "NPT", "ACST", "ACDT", "MMT", "IRST", "IRDT", "NDT", "NST"):
    ok(abbr not in U._TZ_OFFSETS, f"{abbr} is not in the whole-hour table", "")

print("\nan unknown abbreviation still fails OPEN, at UTC")
# Deliberately asserted rather than left implicit: flipping this to None is a
# real change of policy (it would make the write guard refuse a real result),
# so it must be a visible edit to this line, never a silent side effect.
got = U._liqui_date_to_iso("August 20, 2026 - 10:00 {{Abbr/ZZZ}}")
ok(got == "2026-08-20T10:00:00+00:00", "{{Abbr/ZZZ}} -> +00:00", str(got))

print("\nand a date with no template at all is unaffected")
ok(U._liqui_date_to_iso("2026-08-20 10:00") == "2026-08-20T10:00:00+00:00",
   "a bare '%Y-%m-%d %H:%M' still parses at UTC",
   str(U._liqui_date_to_iso("2026-08-20 10:00")))
ok(U._liqui_date_to_iso("") is None, "an empty string is None", "")
ok(U._liqui_date_to_iso("not a date") is None, "garbage is None", "")

print("\nand the OFFSET still round-trips against the real data.json")
# The tie to live data that a reschedule CANNOT falsely break. For every bracket
# fixture, rebuild the Liquipedia string from the stored value's own wall clock
# and re-parse it: the instant must come back identical. If CST silently became
# -06:00, or the regex stopped matching, every one of these moves by hours. If
# Liquipedia reschedules a fixture, the reconstruction follows it and this stays
# green - which is exactly why it checks the offset and not the time.
import datetime  # noqa: E402
import json      # noqa: E402

_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
with open(os.path.join(_root, "data.json"), encoding="utf-8") as _fh:
    _d = json.load(_fh)
_br = (_d.get("bracket") or {}).get("rounds") or {}
_fx = []
for _side in ("upper", "lower"):
    for _rd in _br.get(_side) or []:
        _fx += _rd.get("matches") or []
if (_d.get("bracket") or {}).get("grandFinal"):
    _fx.append(_d["bracket"]["grandFinal"])

# One abbreviation per whole-hour offset, chosen deterministically.
_BY_OFFSET = {}
for _k, _v in sorted(U._TZ_OFFSETS.items()):
    _BY_OFFSET.setdefault(_v, _k)

_checked, _bad = 0, []
for _m in _fx:
    _s = _m.get("scheduled")
    if not _s:
        continue
    _dt = datetime.datetime.fromisoformat(_s)
    _off = _dt.utcoffset()
    if _off is None or _off.total_seconds() % 3600:
        continue                      # this table stores whole hours only
    _abbr = _BY_OFFSET.get(int(_off.total_seconds() // 3600))
    if not _abbr:
        continue
    # Liquipedia writes "August 20, 2026 - 10:00 {{Abbr/CST}}" with no zero pad.
    _raw = "%s %d, %d - %02d:%02d {{Abbr/%s}}" % (
        _dt.strftime("%B"), _dt.day, _dt.year, _dt.hour, _dt.minute, _abbr)
    _got = U._liqui_date_to_iso(_raw)
    _checked += 1
    if _got is None or datetime.datetime.fromisoformat(_got) != _dt:
        _bad.append("%s: %r -> %s, wanted %s" % (_m.get("id"), _raw, _got, _s))
ok(_checked > 0, "there were bracket fixtures to round-trip", str(_checked))
ok(not _bad, "every one re-parses to the same instant", "; ".join(_bad))

print()
print(f"{fail} FAILURE(S)" if fail else "all good")
sys.exit(1 if fail else 0)
