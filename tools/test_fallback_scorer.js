/* The client-side leaderboard fallback must not score a correct pick as wrong.
 *
 * Run: node tools/test_fallback_scorer.js       (needs jsdom)
 *
 * WHY THIS EXISTS
 *
 * lgLeaderboard() prefers the server board and falls back to
 * lgComputeLeaderboard() whenever the RPC yields nothing — and index.html
 * swallows an RPC error into console.warn, so that happens on any transient
 * failure, not just offline.
 *
 * The fallback compared picks to results with RAW STRING EQUALITY: the exact
 * drift that team_norm() and migration 0020 fixed server-side. A pick stored as
 * "BetBoom Team" against a result recorded as "BoomBoys" scored WRONG locally
 * while the real leaderboard scored it right — two boards disagreeing about the
 * same person, with no error shown.
 *
 * It also scores two of roughly nine rules, so its totals are always lower and
 * its ORDER can differ. It now says so on screen; this file pins both.
 */
const fs = require("fs");
const path = require("path");

let JSDOM;
try { ({ JSDOM } = require("jsdom")); }
catch (e) { console.error("CANNOT RUN: jsdom missing.  npm install"); process.exit(1); }

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data.json"), "utf8"));

let fail = 0;
const ok = (c, m, x) => { console.log((c ? "  ok   " : "  FAIL ") + m + (x ? "   " + x : "")); if (!c) fail++; };

const script = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/.exec(html)[1].replace(/\ninit\(\);?/, "\n");
const dom = new JSDOM("<!doctype html><html><body><div id='app'></div></body></html>",
  { url: "https://dota2tileague.com/", runScripts: "dangerously", pretendToBeVisual: true });
const w = dom.window;
w.fetch = () => Promise.resolve({ ok: false, json: async () => ({}), text: async () => "" });
w.scrollTo = () => {}; w.console.error = () => {};
/* jsdom has no IntersectionObserver and wireNav() uses one. Stubbing it is the
   difference between exercising render() and skipping it. */
w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
const el = w.document.createElement("script"); el.textContent = script; w.document.body.appendChild(el);

ok(typeof w.samePick === "function", "samePick lifted from the page");
ok(typeof w.lgComputeLeaderboard === "function", "lgComputeLeaderboard lifted from the page");

/* ---- 1. COLD: DATA not loaded, so tiFieldNames() is empty ----
   canonTeam() only applies an alias when the target is in the field list, which
   is empty until DATA arrives. A cold render must still resolve the alias. */
const DRIFT = [
  ["BetBoom Team", "BoomBoys", true],
  ["BoomBoys", "BetBoom Team", true],
  ["Iron Wing TI 2026", "Iron Wing", true],
  ["Aurora", "Aurora Gaming", true],
  ["Team Spirit", "Team Spirit", true],
  ["OG", "Team Spirit", false],
  ["Xtreme Gaming", "Team Liquid", false],
  [null, "BoomBoys", false],
  ["BoomBoys", null, false],
];
for (const [pick, winner, want] of DRIFT) {
  ok(w.samePick(pick, winner) === want,
     `cold: ${JSON.stringify(pick)} vs ${JSON.stringify(winner)} -> ${want}`,
     String(w.samePick(pick, winner)));
}

/* ---- 2. WARM: DATA loaded, field list primed ---- */
w.render(data);
const field = w.tiFieldNames();
ok(field.length > 0, "field list is primed after render", `${field.length} names`);
for (const [pick, winner, want] of DRIFT) {
  ok(w.samePick(pick, winner) === want,
     `warm: ${JSON.stringify(pick)} vs ${JSON.stringify(winner)} -> ${want}`,
     String(w.samePick(pick, winner)));
}

/* ---- 3. it actually changes the score ---- */
const done = [];
for (const rd of data.groupStage.rounds || []) {
  for (const m of rd.matches || []) {
    if (m.status !== "completed") continue;
    const a = m.teamA || {}, b = m.teamB || {};
    if (a.score === b.score) continue;
    done.push({ id: m.id, winner: a.score > b.score ? a.name : b.name });
  }
}
ok(done.length > 0, "found completed matches to score against", `${done.length}`);

const drifted = (n) => (n === "BoomBoys" ? "BetBoom Team" : n === "Iron Wing" ? "Iron Wing TI 2026" : n);
const withDrift = done.filter((d) => drifted(d.winner) !== d.winner);
console.log(`         (${withDrift.length} completed matches were won by a team whose name drifts)`);

const lg = {
  me: "Tester", rules: {}, board: null, members: ["Tester"],
  predictions: Object.fromEntries(done.map((d) => [d.id, { pick: drifted(d.winner), sa: 2, sb: 0, locked: true }])),
  otherPredictions: {},
};
const board = w.lgComputeLeaderboard(lg);
const me = board.find((p) => p.name === "Tester");
ok(!!me, "the fallback produced a row for the tester");
ok(me && me.correct === done.length,
   "every correct pick counts, drifted names included",
   me ? `${me.correct}/${done.length}` : "");


/* The degraded path must not throw on a partial league object — it runs exactly
   when something has already failed, and an exception here blanks the page. */
for (const partial of [{}, { me: "X" }, { me: "X", predictions: {} }, { me: "X", members: null }]) {
  let threw = null;
  try { w.lgComputeLeaderboard({ rules: {}, ...partial }); } catch (e) { threw = e.message; }
  ok(!threw, `fallback survives a partial league object ${JSON.stringify(partial)}`, threw || "");
}

/* ---- 4. the board must announce itself as provisional ---- */
const rendered = w.lgLeaderboard({ ...lg, board: null });
ok(/lb-provisional/.test(rendered), "a fallback board is labelled provisional");
ok(/Provisional/.test(rendered), "the label says so in words");
const server = w.lgLeaderboard({ ...lg, board: [{ username: "Tester", points: 10, correct: 1, scored: 1 }] });
ok(!/lb-provisional/.test(server), "a SERVER board carries no provisional label");

console.log(fail ? `\n${fail} CHECK(S) FAILED` : "\nthe fallback scorer agrees with the server on names");
process.exit(fail ? 1 : 0);
