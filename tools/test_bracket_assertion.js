/* The production bracket check must fire on a fabrication and stay quiet on a
 * real early finish.
 *
 * Run: node tools/test_bracket_assertion.js
 *
 * WHY THIS EXISTS
 *
 * On 16 Aug 2026 the whole TI playoff bracket arrived as finished, four days
 * early. It landed in `data.bracket` - the one structure check_production.js
 * walked only for team names and never status-checked.
 *
 * The obvious fix, "fail if a fixture is decided before its own kickoff", is
 * wrong, and this file exists mostly to hold the line against re-simplifying
 * it to that. Both writers in update_data.py deliberately allow a result to
 * arrive before the published kickoff - _build_match up to an hour, the
 * OpenDota merge up to six - because a Bo3 that ends 2-0 in seventy minutes
 * frees the stage and the next series starts early. test_no_future_results.py
 * and test_opendota_future_merge.py both ASSERT that behaviour. A flat
 * ten-minute rule would call that correct data a failure and redden the build
 * every fifteen minutes until the clock caught up, for up to twenty-four
 * consecutive runs, during the playoffs. check_production.js's own comment
 * says why that is the worst available outcome: a red build nobody trusts is
 * how a real failure gets missed.
 *
 * So there are two rules, both keyed on what a legitimate early settle cannot
 * look like: beyond any writer's grace, and in bulk.
 *
 * THIS DRIVES THE SHIPPED FUNCTION, not a copy of it. check_production.js
 * exports bracketVerdict and does nothing on require. A review found that
 * lifting the block into a test proves only that the lifted block works.
 *
 * THE FABRICATION BELOW IS THE REAL ONE, copied out of data.json at commit
 * 7f26cb16 (16 Aug 22:50Z). Ids, teams, scores and kickoff times are verbatim.
 * It is inlined rather than read from git because CI checks out at depth 1.
 */
const path = require("path");
const { bracketVerdict, collectBracketFixtures } =
  require(path.join(__dirname, "check_production.js"));

let fail = 0;
const ok = (cond, msg, extra) => {
  console.log((cond ? "  ok   " : "  FAIL ") + msg + (extra ? "   " + extra : ""));
  if (!cond) fail++;
};

/* The clock is an ARGUMENT, so every assertion here is fixed in time. Tests
   that read Date.now() go quietly vacuous the moment the fixtures they describe
   fall into the past - and all fourteen of these do, between 20 and 23 Aug. */
const T = (s) => Date.parse(s);
const BEFORE = T("2026-08-16T22:50:00Z");   /* when the fabrication was live */

const FABRICATED = [
  { id: "me-r1m1", status: "completed", scheduled: "2026-08-20T10:00:00+08:00",
    teamA: { name: "Iron Wing", score: 2 }, teamB: { name: "Team Spirit", score: 1 } },
  { id: "me-r1m2", status: "completed", scheduled: "2026-08-20T13:00:00+08:00",
    teamA: { name: "TEAM VISION", score: 2 }, teamB: { name: "BoomBoys", score: 0 } },
  { id: "me-r1m3", status: "completed", scheduled: "2026-08-20T16:00:00+08:00",
    teamA: { name: "Team Liquid", score: 2 }, teamB: { name: "Team Yandex", score: 1 } },
  { id: "me-r1m4", status: "completed", scheduled: "2026-08-20T19:00:00+08:00",
    teamA: { name: "Nigma Galaxy", score: 2 }, teamB: { name: "Team Falcons", score: 1 } },
  { id: "me-r1m5", status: "completed", scheduled: "2026-08-21T10:00:00+08:00",
    teamA: { name: "Team Spirit", score: 2 }, teamB: { name: "BoomBoys", score: 1 } },
  { id: "me-r1m6", status: "completed", scheduled: "2026-08-21T13:00:00+08:00",
    teamA: { name: "Team Yandex", score: 1 }, teamB: { name: "Team Falcons", score: 2 } },
  { id: "me-r2m1", status: "completed", scheduled: "2026-08-21T16:00:00+08:00",
    teamA: { name: "Iron Wing", score: 1 }, teamB: { name: "TEAM VISION", score: 2 } },
  { id: "me-r2m2", status: "completed", scheduled: "2026-08-21T19:00:00+08:00",
    teamA: { name: "Team Liquid", score: 2 }, teamB: { name: "Nigma Galaxy", score: 1 } },
  { id: "me-r2m3", status: "completed", scheduled: "2026-08-22T13:00:00+08:00",
    teamA: { name: "Nigma Galaxy", score: 2 }, teamB: { name: "Team Spirit", score: 1 } },
  { id: "me-r2m4", status: "completed", scheduled: "2026-08-22T10:00:00+08:00",
    teamA: { name: "Iron Wing", score: 2 }, teamB: { name: "Team Falcons", score: 1 } },
  { id: "me-r3m1", status: "completed", scheduled: "2026-08-22T19:00:00+08:00",
    teamA: { name: "Nigma Galaxy", score: 1 }, teamB: { name: "Iron Wing", score: 2 } },
  { id: "me-r4m1", status: "completed", scheduled: "2026-08-22T16:00:00+08:00",
    teamA: { name: "TEAM VISION", score: 2 }, teamB: { name: "Team Liquid", score: 1 } },
  { id: "me-r4m2", status: "completed", scheduled: "2026-08-23T10:00:00+08:00",
    teamA: { name: "Team Liquid", score: 2 }, teamB: { name: "Iron Wing", score: 1 } },
];
const FAB_GF = { id: "me-r5m1", status: "completed", scheduled: "2026-08-23T13:00:00+08:00",
  teamA: { name: "TEAM VISION", score: 3 }, teamB: { name: "Team Liquid", score: 2 } };

/* The shape the live file actually uses: upper/lower rounds, a grandFinal
   beside them, and the five 16 Aug tiebreakers under groupStage. */
const doc = (matches, gf, elim) => ({
  bracket: {
    rounds: {
      upper: [{ name: "R", matches: matches.slice(0, 7) }],
      lower: [{ name: "L", matches: matches.slice(7) }],
    },
    grandFinal: gf === undefined ? null : gf,
  },
  groupStage: { eliminationMatches: elim || [] },
});
const played = (id, when, st) => ({
  id, status: st || "completed", scheduled: when,
  teamA: { name: "A", score: 2 }, teamB: { name: "B", score: 1 },
});
const rel = (fromIso, hours) => new Date(T(fromIso) + hours * 3600000).toISOString();

console.log("the real 16 Aug fabrication, judged at the moment it was live");
let v = bracketVerdict(doc(FABRICATED, FAB_GF), BEFORE);
ok(v.beyondGrace.length === 14, "all 14 are beyond any writer's grace", v.beyondGrace.length + "/14");
ok(v.earlyAll.length === 14, "and all 14 count as decided before kickoff", v.earlyAll.length + "/14");
ok(v.judged.length === 14, "all 14 were actually judged, not skipped", String(v.judged.length));
ok(v.beyondGrace.some((l) => l.indexOf("me-r5m1 reported completed 3-2") === 0),
   "the grand final is named with its fabricated score",
   v.beyondGrace.filter((l) => l.indexOf("me-r5m1") === 0)[0] || "");

console.log("\nthe same fabrication would ALSO be caught by bulk alone");
/* Belt and braces: if someone later widens NO_WRITER_GRACE_H, rule 2 must
   still fire. Judged an hour before the first kickoff, so the near fixtures
   are inside six hours and rule 1 alone would not catch them all. */
v = bracketVerdict(doc(FABRICATED, FAB_GF), T("2026-08-20T01:00:00Z"));
ok(v.earlyAll.length >= 2, "still bulk at T-1h from the first fixture",
   v.earlyAll.length + " at once");

console.log("\nA LEGITIMATE EARLY FINISH MUST NOT FAIL THE BUILD");
/* These are the states test_no_future_results.py and test_opendota_future_merge.py
   assert the writers are ALLOWED to produce. If any of them reddens here, the
   test files contradict each other and production goes red on correct data. */
const NOW = T("2026-08-20T04:00:00Z");
const LEGIT = [
  ["a Liquipedia settle 45 min early", 0.75, "completed"],
  ["a flip to live 12 min before kickoff", 0.2, "live"],
  ["an OpenDota settle 3h early - the stage freed up", 3, "completed"],
  ["an OpenDota settle 5.9h early, at the very edge of its grace", 5.9, "completed"],
  ["a schedule pushed forward 30 min after the match was played", 0.5, "completed"],
];
for (const [label, ahead, st] of LEGIT) {
  const r = bracketVerdict(doc([played("me-r1m2", rel("2026-08-20T04:00:00Z", ahead), st)], null), NOW);
  ok(r.beyondGrace.length === 0 && r.earlyAll.length < 2, label + ": no failure",
     r.earlyAll.length ? "noted only" : "");
}

console.log("\nbut the same states in BULK are a fabrication, not an early finish");
v = bracketVerdict(doc([played("me-r1m2", rel("2026-08-20T04:00:00Z", 3)),
                        played("me-r1m3", rel("2026-08-20T04:00:00Z", 4))], null), NOW);
ok(v.earlyAll.length === 2 && v.beyondGrace.length === 0,
   "two at once trips rule 2 while rule 1 stays quiet", v.earlyAll.length + " at once");

console.log("\nand a single fixture beyond six hours trips rule 1 on its own");
v = bracketVerdict(doc([played("me-r5m1", rel("2026-08-20T04:00:00Z", 96))], null), NOW);
ok(v.beyondGrace.length === 1, "96h ahead: no writer in update_data.py can produce this", "");
v = bracketVerdict(doc([played("me-r5m1", rel("2026-08-20T04:00:00Z", 6.5))], null), NOW);
ok(v.beyondGrace.length === 1, "6.5h ahead: just past the OpenDota grace", "");
v = bracketVerdict(doc([played("me-r5m1", rel("2026-08-20T04:00:00Z", 5.9))], null), NOW);
ok(v.beyondGrace.length === 0, "5.9h ahead: still inside it", "");

console.log("\nnothing in a healthy playoff day trips either rule");
/* Every fixture already played, which is what 20-23 Aug looks like from the
   afternoon onwards. */
v = bracketVerdict(doc([played("me-r1m1", "2026-08-20T02:00:00Z"),
                        played("me-r1m2", "2026-08-20T05:00:00Z"),
                        played("me-r1m3", "2026-08-20T08:00:00Z", "live")], null),
                   T("2026-08-20T09:30:00Z"));
ok(v.beyondGrace.length === 0 && v.earlyAll.length === 0,
   "three played fixtures, one still live", "");
ok(v.judged.length === 3, "and all three were judged", String(v.judged.length));

console.log("\nshapes that must not crash or lie");
const SHAPES = [
  ["no bracket key at all (the Liquipedia-outage branch)", { groupStage: {} }, 0],
  ["a null grandFinal", doc([played("me-r1m1", "2026-08-20T02:00:00Z")], null), 1],
  ["no eliminationMatches", { bracket: { rounds: {} } }, 0],
  ["an empty document", {}, 0],
  ["null", null, 0],
];
for (const [label, d, wantTotal] of SHAPES) {
  let r = null, threw = null;
  try { r = bracketVerdict(d, NOW); } catch (e) { threw = e.message; }
  ok(!threw, label + ": does not throw", threw || "");
  if (r) ok(r.total === wantTotal, "  and reports " + wantTotal + " fixture(s)", String(r.total));
}

console.log("\nthe count reported is what was JUDGED, never the array length");
/* The first version printed the array length. Before the playoffs every bracket
   fixture is 'upcoming', so it printed 19 while judging 5 - a number that reads
   as 19 things verified. That is the false-comfort shape this project has
   shipped before, and it is why bracketVerdict returns `judged` at all. */
const mixed = doc([played("me-r1m1", "2026-08-20T02:00:00Z"),
                   { id: "me-r1m2", status: "upcoming", scheduled: "2026-08-20T05:00:00Z",
                     teamA: { name: "A", score: null }, teamB: { name: "B", score: null } },
                   { id: "me-r1m3", status: "completed", scheduled: null,
                     teamA: { name: "A", score: 2 }, teamB: { name: "B", score: 0 } }], null);
v = bracketVerdict(mixed, NOW);
ok(collectBracketFixtures(mixed).length === 3, "three fixtures present", "");
ok(v.total === 3 && v.judged.length === 1,
   "but only the one with a status AND a date is judged",
   v.judged.length + " of " + v.total);

console.log("\nthe known blind spot is real, and is asserted rather than hoped about");
/* Stated so nobody reads the green line as more than it is: once a match has
   kicked off, the clock has nothing left to say. Closing this needs OpenDota
   game-row corroboration inside the updater, which is a post-event change. */
v = bracketVerdict(doc([played("me-r5m1", "2026-08-23T05:00:00Z")], null), T("2026-08-23T05:10:00Z"));
ok(v.beyondGrace.length === 0 && v.earlyAll.length === 0,
   "a result faked 10 min AFTER kickoff is NOT caught here - by design", "");

console.log("\nLATE is a failure too, not only EARLY");
/* Added 20 Aug after the fixture that actually reached users: me-r1m2 had been
   played for 28 minutes while the site read "upcoming", and production reported
   healthy the whole time because every rule here only looked for results that
   were too early. */
const T0 = T("2026-08-20T06:00:00Z");
v = bracketVerdict(doc([{ id: "me-r1m2", status: "upcoming",
  scheduled: "2026-08-20T05:30:00Z",
  teamA: { name: "A", score: null }, teamB: { name: "B", score: null } }], null), T0);
ok(v.lateStart.length === 0,
   "30 min past kickoff: inside the tolerance, not flagged", String(v.lateStart.length));

v = bracketVerdict(doc([{ id: "me-r1m2", status: "upcoming",
  scheduled: "2026-08-20T05:00:00Z",
  teamA: { name: "A", score: null }, teamB: { name: "B", score: null } }], null), T0);
ok(v.lateStart.length === 1, "60 min past kickoff and still upcoming: FLAGGED", v.lateStart[0] || "");

v = bracketVerdict(doc([{ id: "me-r1m3", status: "upcoming",
  scheduled: "2026-08-20T08:00:00Z",
  teamA: { name: "A", score: null }, teamB: { name: "B", score: null } }], null), T0);
ok(v.lateStart.length === 0, "a fixture that has not started yet is not late", "");

v = bracketVerdict(doc([played("me-r1m1", "2026-08-20T02:00:00Z")], null), T0);
ok(v.lateStart.length === 0, "a completed fixture is never late", "");

v = bracketVerdict(doc([{ id: "me-r2m1", status: "upcoming", scheduled: null,
  teamA: { name: "TBD", score: null }, teamB: { name: "TBD", score: null } }], null), T0);
ok(v.lateStart.length === 0, "an undrawn TBD fixture with no date is not late", "");

console.log("\nand a status that stopped moving");
v = bracketVerdict(doc([played("me-r1m1", "2026-08-19T22:00:00Z", "live")], null), T0);
ok(v.stuckLive.length === 1, "live for 8h is stuck", v.stuckLive[0] || "");
v = bracketVerdict(doc([played("me-r1m1", "2026-08-20T03:30:00Z", "live")], null), T0);
ok(v.stuckLive.length === 0, "live for 2.5h is just a long Bo3", "");

console.log();
console.log(fail ? fail + " FAILURE(S)" : "all good");
process.exit(fail ? 1 : 0);
