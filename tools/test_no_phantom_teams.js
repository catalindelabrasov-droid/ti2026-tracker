/* A team named only in a non-Swiss match must not join the Swiss table.
 *
 * Run: node tools/test_no_phantom_teams.js       (needs jsdom)
 *
 * WHY THIS EXISTS
 *
 * computeGroupStandings seeded from every merged match BEFORE applying the
 * stage filter, so a team named in an el- or me- fixture joined the standings
 * at 0-0 even though its results were correctly excluded.
 *
 * Invisible while every fixture spells a name exactly as the Swiss rounds do —
 * and this project has had a name drift twice. Putting "BetBoom Team" in an
 * elimination fixture while the rounds say "BoomBoys" grew the board from 16
 * rows to 18 and put a phantom 0-0 bucket on screen. The two windows where that
 * is reachable are the elimination round and the playoffs.
 */
const fs = require("fs");
const path = require("path");

let JSDOM;
try { ({ JSDOM } = require("jsdom")); }
catch (e) { console.error("CANNOT RUN: jsdom missing.  npm install"); process.exit(1); }

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data.json"), "utf8"));
const script = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/.exec(html)[1].replace(/\ninit\(\);?/, "\n");

let fail = 0;
const ok = (c, m, x) => { console.log((c ? "  ok   " : "  FAIL ") + m + (x ? "   " + x : "")); if (!c) fail++; };

function boot() {
  const dom = new JSDOM("<!doctype html><html><body><div id='app'></div></body></html>",
    { url: "https://dota2tileague.com/", runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window;
  w.fetch = () => Promise.resolve({ ok: false, json: async () => ({}), text: async () => "" });
  w.scrollTo = () => {}; w.console.error = () => {};
  w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  const s = w.document.createElement("script");
  s.textContent = script;
  w.document.body.appendChild(s);
  return w;
}

const base = boot().computeGroupStandings(data).rows || [];
ok(base.length === 16, "baseline is the 16-team field", String(base.length));

/* A drifted name in the elimination round. */
const elim = JSON.parse(JSON.stringify(data));
if ((elim.groupStage.eliminationMatches || []).length) {
  elim.groupStage.eliminationMatches[0].teamA = { name: "BetBoom Team", score: null };
  elim.groupStage.eliminationMatches[0].teamB = { name: "Iron Wing TI 2026", score: null };
  const rows = boot().computeGroupStandings(elim).rows || [];
  const ghosts = rows.filter((r) => !base.some((b) => b.team === r.team));
  ok(!ghosts.length, "a drifted name in an el- fixture creates no phantom row",
     ghosts.map((r) => `${r.team} ${r.wins}-${r.losses}`).join(", "));
  ok(rows.length === base.length, "team count is unchanged by el- fixtures", `${rows.length}`);
}

/* And in the playoffs — reachable from 20 Aug. */
const pl = JSON.parse(JSON.stringify(data));
const up = ((pl.bracket || {}).rounds || {}).upper || [];
if (up.length && (up[0].matches || []).length) {
  up[0].matches[0].teamA = { name: "BetBoom Team", score: 2 };
  up[0].matches[0].teamB = { name: "Aurora", score: 0 };
  up[0].matches[0].status = "completed";
  const rows = boot().computeGroupStandings(pl).rows || [];
  const ghosts = rows.filter((r) => !base.some((b) => b.team === r.team));
  ok(!ghosts.length, "a drifted name in a me- fixture creates no phantom row",
     ghosts.map((r) => r.team).join(", "));
  /* And the playoff RESULT must still not count toward the Swiss record. */
  const bb = rows.find((r) => r.team === "BoomBoys");
  const before = base.find((r) => r.team === "BoomBoys");
  if (bb && before) ok(bb.wins === before.wins && bb.losses === before.losses,
    "a playoff result does not move a Swiss record",
    `${before.wins}-${before.losses} -> ${bb.wins}-${bb.losses}`);
}

/* Real Swiss teams must still be seeded even with an empty standings array —
   the fix must not make anyone disappear. */
const noStandings = JSON.parse(JSON.stringify(data));
noStandings.groupStage.standings = [];
const rows2 = boot().computeGroupStandings(noStandings).rows || [];
ok(rows2.length === base.length,
   "teams are still found with no stored standings array", `${rows2.length} vs ${base.length}`);

console.log(fail ? `\n${fail} CHECK(S) FAILED` : "\nno phantom teams reach the Swiss table");
process.exit(fail ? 1 : 0);
