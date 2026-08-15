/* The two guards inside computeGroupStandings that nothing else covers.
 *
 * Run: node tools/test_standings_guards.js       (needs jsdom)
 *
 * WHY THIS EXISTS
 *
 * A mutation pass deleted `if(Math.max(sa,sb)<need) return;` — the line that
 * stops a series being counted while it is still being played — and the entire
 * suite stayed green. With a live Bo3 on the board that mutation changes real
 * standings today:
 *
 *     Nigma Galaxy  2-1  ->  3-1
 *     Vici Gaming   2-1  ->  2-2
 *
 * test_swiss_thresholds could not catch it because it never calls
 * computeGroupStandings — it rebuilds records itself from status==="completed".
 * test_elimination_round does call it, but its real-data assertions are only
 * "16 rows" and "nobody over 5 games", and its fast-forward then overwrites the
 * live match before anything stronger runs.
 *
 * So this asserts the record of a team with a match IN PROGRESS, which is the
 * one state a Swiss table gets wrong most visibly.
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
const s = w.document.createElement("script"); s.textContent = script; w.document.body.appendChild(s);
ok(typeof w.computeGroupStandings === "function", "computeGroupStandings lifted from the page");

const recOf = (rows, team) => rows.find((r) => r.team === team) || null;

/* ---- 1. a series in progress must not be counted ---- */
const base = JSON.parse(JSON.stringify(data));
/* Build the state deliberately rather than hoping today's data contains it:
   two teams with a settled history, then a Bo3 at 1-0 — undecided, because a
   Bo3 needs 2. A fixture that does not actually contain a live series is how
   this guard went untested in the first place. */
const rounds = base.groupStage.rounds || [];
const A = "Team Spirit", B = "TEAM VISION";
const live = { id: "gs-r9-m1", bestOf: 3, status: "live", scheduled: "2026-08-15T10:00:00Z",
               teamA: { name: A, score: 1 }, teamB: { name: B, score: 0 } };
rounds.push({ name: "Round 9", matches: [live] });

const before = w.computeGroupStandings(base).rows || [];
ok(!!recOf(before, A) && !!recOf(before, B), "both teams are in the table");
const aBefore = recOf(before, A), bBefore = recOf(before, B);

/* Now decide it and confirm the record MOVES — proving the assertion above is
   about the guard, not about the fixture being ignored entirely. */
const after = JSON.parse(JSON.stringify(base));
const lm = after.groupStage.rounds[after.groupStage.rounds.length - 1].matches[0];
lm.teamA.score = 2; lm.status = "completed";
const rowsAfter = w.computeGroupStandings(after).rows || [];
const aAfter = recOf(rowsAfter, A), bAfter = recOf(rowsAfter, B);

ok(aAfter.wins === aBefore.wins + 1,
   `${A}: a DECIDED win is counted`, `${aBefore.wins}-${aBefore.losses} -> ${aAfter.wins}-${aAfter.losses}`);
ok(bAfter.losses === bBefore.losses + 1,
   `${B}: a DECIDED loss is counted`, `${bBefore.wins}-${bBefore.losses} -> ${bAfter.wins}-${bAfter.losses}`);

/* The real assertion: at 1-0 in a Bo3, neither record may have moved. */
const clean = w.computeGroupStandings(JSON.parse(JSON.stringify(data))).rows || [];
ok(recOf(clean, A).wins === aBefore.wins && recOf(clean, A).losses === aBefore.losses,
   `${A}: an IN-PLAY Bo3 at 1-0 is not counted`,
   `${aBefore.wins}-${aBefore.losses}`);
ok(recOf(clean, B).wins === bBefore.wins && recOf(clean, B).losses === bBefore.losses,
   `${B}: an IN-PLAY Bo3 at 1-0 is not counted`,
   `${bBefore.wins}-${bBefore.losses}`);

/* ---- 2. a Bo5 needs three, not two ---- */
const bo5 = JSON.parse(JSON.stringify(data));
bo5.groupStage.rounds.push({ name: "Round 9", matches: [
  { id: "gs-r9-m2", bestOf: 5, status: "live", scheduled: "2026-08-15T10:00:00Z",
    teamA: { name: A, score: 2 }, teamB: { name: B, score: 0 } }] });
const r5 = w.computeGroupStandings(bo5).rows || [];
ok(recOf(r5, A).wins === aBefore.wins,
   `${A}: 2-0 in a Bo5 is still undecided`, `${recOf(r5, A).wins}-${recOf(r5, A).losses}`);

/* ---- 3. today's live data, stated as a value ---- */
const liveNow = [];
for (const rd of data.groupStage.rounds || []) {
  for (const m of rd.matches || []) {
    const sa = (m.teamA || {}).score, sb = (m.teamB || {}).score;
    if (m.status === "live" && typeof sa === "number" && typeof sb === "number" &&
        Math.max(sa, sb) < Math.floor((m.bestOf || 3) / 2) + 1) liveNow.push(m.id);
  }
}
console.log(`         (data.json currently has ${liveNow.length} undecided in-play series${liveNow.length ? ": " + liveNow.join(", ") : ""})`);

console.log(fail ? `\n${fail} CHECK(S) FAILED` : "\nin-play series are not counted");
process.exit(fail ? 1 : 0);
