/* Play the elimination round and check the Swiss board survives it.
 *
 * Run: node tools/test_elimination_round.js        (needs jsdom)
 *
 * WHY THIS EXISTS
 *
 * allMatches() pushes groupStage.eliminationMatches (el-r1m1…m5) into the same
 * pool as the Swiss rounds, and computeGroupStandings counted anything matching
 * /^(gs|el)-/. All five are TBD today, so nothing looked wrong — the damage was
 * dated, not present.
 *
 * The moment they are played, a 3-2 team that wins becomes 4-2: six games in a
 * five-round Swiss. Worse, a 3-2 team that LOSES and a 2-3 team that WINS both
 * land on 3-3, so one bucket would hold teams that advanced and teams that were
 * knocked out, labelled identically and with no way to tell them apart.
 *
 * So this does not inspect the source. It loads the real page, fabricates
 * finished elimination matches from the live standings, and re-runs the real
 * computeGroupStandings over them.
 */
const fs = require("fs");
const path = require("path");

let JSDOM;
try { ({ JSDOM } = require("jsdom")); }
catch (e) {
  console.error("test_elimination_round CANNOT RUN: jsdom is not installed.");
  console.error("  npm install");
  process.exit(1);
}

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data.json"), "utf8"));

let fail = 0;
const ok = (c, m, x) => { console.log((c ? "  ok   " : "  FAIL ") + m + (x ? "   " + x : "")); if (!c) fail++; };

/* Execute the page's inline script so we test the shipped functions, not a
   re-typed copy. init() is stubbed out — it fetches and renders, neither of
   which this needs. */
const script = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/.exec(html)[1]
  .replace(/\ninit\(\);?/, "\n/* init() suppressed for testing */");

/* Inject as a real <script>, not w.eval(): eval runs in a context where
   `window` and `localStorage` are not globals, and the page touches both at
   load. A <script> element executes in the page context, which is what we are
   trying to reproduce. */
const dom = new JSDOM("<!doctype html><html><body><div id='app'></div></body></html>",
  { url: "https://dota2tileague.com/", runScripts: "dangerously", pretendToBeVisual: true });
const w = dom.window;
w.fetch = () => Promise.resolve({ ok: false, json: async () => ({}), text: async () => "" });
w.scrollTo = () => {};
w.alert = () => {};
/* The page logs a Supabase init failure with no network — expected, and noisy. */
const realErr = w.console.error;
w.console.error = (...a) => { if (!/Supabase/.test(String(a[0]))) realErr(...a); };

const el = w.document.createElement("script");
el.textContent = script;
w.document.body.appendChild(el);

if (typeof w.computeGroupStandings !== "function") {
  console.error("the page script did not define computeGroupStandings — it threw during load");
  process.exit(1);
}

ok(typeof w.computeGroupStandings === "function", "computeGroupStandings lifted from the page");
ok(typeof w.SWISS_ID !== "undefined" || /SWISS_ID/.test(script), "SWISS_ID exists");

const ROUNDS = (data.groupStage.rounds || []).length;

/* ---- 1. today: nothing played in the elimination round ---- */
const before = w.computeGroupStandings(data).rows || [];
ok(before.length === 16, `16 teams before the elimination round`, `${before.length}`);
const maxBefore = Math.max(...before.map((r) => r.wins + r.losses));
ok(maxBefore <= ROUNDS, `nobody exceeds ${ROUNDS} games before`, `max ${maxBefore}`);

/* ---- 2. fast-forward to the end of the Swiss ----
   The elimination round only ever involves 3-2 and 2-3 teams, and neither
   record exists until round 5 is played. A first version of this test skipped
   that, found zero teams on 3-2, paired invented names, and passed without
   touching the dangerous path at all. So play the Swiss out first. */
const clone = JSON.parse(JSON.stringify(data));
const rounds = clone.groupStage.rounds || [];
const lastRound = rounds[rounds.length - 1];

/* Complete every round EXCEPT the last, then decide the last from the resulting
   standings.
 *
 * The first version completed ALL named matches, including the final round, and
 * only afterwards looked for teams on 3-1 / 2-2 / 1-3. That works only while
 * the final round is undrawn. The moment it IS drawn — hours away as this is
 * written — the fast-forward plays it, nobody is left in those buckets, the
 * pool comes back empty, `lastRound.matches = []` DELETES the round, and the
 * file fails four ways for a fixture reason on the busiest day of the stage. A
 * suite that is red for a known-bogus reason stops being read.
 */
const complete = (m) => {
  const a = (m.teamA || {}).name, b = (m.teamB || {}).name;
  if (!a || !b || a === "TBD" || b === "TBD") return false;
  m.teamA = { name: a, score: 2 };
  m.teamB = { name: b, score: 0 };
  m.status = "completed";
  return true;
};

for (const rd of rounds) {
  if (rd === lastRound) continue;                 // decided below
  for (const m of rd.matches || []) if (m.status !== "completed") complete(m);
}

if (lastRound) {
  const mid = w.computeGroupStandings(clone).rows || [];
  const drawn = (lastRound.matches || []).filter((m) => ((m.teamA || {}).name || "TBD") !== "TBD");
  /* A real draw is only usable if it RECONCILES with the fast-forward.
     The live draw is made against standings that still contain unfinished
     matches; completing those first can put a team in the final round that has
     already played all ROUNDS games, producing a 5-0 in a five-round Swiss.
     That is a fixture artefact, not a product defect, so check before trusting
     it and say which path was taken. */
  let usedDraw = false;
  if (drawn.length) {
    const snapshot = JSON.stringify(lastRound.matches);
    for (const m of lastRound.matches) if (m.status !== "completed") complete(m);
    const trial = w.computeGroupStandings(clone).rows || [];
    const impossible = trial.filter((r) => r.wins + r.losses > ROUNDS || r.wins > ROUNDS - 1 || r.losses > ROUNDS - 1);
    if (impossible.length) {
      console.log(`         (real draw does not reconcile with the fast-forward — ` +
                  `${impossible.map((r) => r.team + " " + r.wins + "-" + r.losses).join(", ")}; synthesising instead)`);
      lastRound.matches = JSON.parse(snapshot);
    } else {
      usedDraw = true;
      console.log(`         (final round already drawn: ${drawn.length} real pairings used)`);
    }
  }
  if (!usedDraw) {
    /* Undrawn: pair the survivors by record, the way Liquipedia does. */
    const pool = [];
    for (const rec of ["3-1", "2-2", "1-3"]) {
      const [rw, rl] = rec.split("-").map(Number);
      pool.push(...mid.filter((r) => r.wins === rw && r.losses === rl).map((r) => r.team));
    }
    ok(pool.length >= 4, "enough survivors to synthesise the final round", `${pool.length} teams`);
    lastRound.matches = [];
    for (let i = 0; i + 1 < pool.length; i += 2) {
      lastRound.matches.push({
        id: `gs-r${rounds.length}-m${i / 2 + 1}`, bestOf: 3, status: "completed",
        teamA: { name: pool[i], score: 2 }, teamB: { name: pool[i + 1], score: 0 },
      });
    }
    console.log(`         (final round undrawn: synthesised ${lastRound.matches.length} pairings)`);
  }
}
const endOfSwiss = w.computeGroupStandings(clone).rows || [];
const swissBuckets = [...new Set(endOfSwiss.map((r) => `${r.wins}-${r.losses}`))].sort();
console.log(`         (end of Swiss: ${swissBuckets.join("  ")})`);
ok(endOfSwiss.every((r) => r.wins + r.losses <= ROUNDS),
   `every team has played at most ${ROUNDS} Swiss rounds`);

const at = (w_, l_) => endOfSwiss.filter((r) => r.wins === w_ && r.losses === l_).map((r) => r.team);
const winners = at(3, 2), losers = at(2, 3);
ok(winners.length > 0 && losers.length > 0,
   "the simulation actually produced 3-2 and 2-3 teams",
   `${winners.length} on 3-2, ${losers.length} on 2-3`);
console.log(`         (elimination round: ${winners.length} on 3-2 vs ${losers.length} on 2-3)`);

const elim = clone.groupStage.eliminationMatches || [];
ok(elim.length > 0, `${elim.length} elimination fixtures exist in data.json`);
/* ALTERNATE the outcomes. If every 3-2 team wins, nobody lands on 3-3 and the
   worst case never forms. The catastrophe needs both: a 3-2 team that loses and
   a 2-3 team that wins, which under the old code both become 3-3 — one bucket
   holding an eliminated team and an advancing one, labelled identically. */
for (let i = 0; i < elim.length; i++) {
  const a = winners[i] || `Winner ${i}`, b = losers[i] || `Loser ${i}`;
  const upset = i % 2 === 1;                 // the 2-3 team wins this one
  elim[i].teamA = { name: a, score: upset ? 0 : 2 };
  elim[i].teamB = { name: b, score: upset ? 2 : 0 };
  elim[i].status = "completed";
  elim[i].bestOf = 3;
}

const after = w.computeGroupStandings(clone).rows || [];

/* ---- 3. the assertions that would have caught it ---- */
const over = after.filter((r) => (r.wins + r.losses) > ROUNDS);
ok(!over.length, `no team exceeds ${ROUNDS} games after the elimination round`,
   over.map((r) => `${r.team} ${r.wins}-${r.losses}`).join(", "));

const buckets = [...new Set(after.map((r) => `${r.wins}-${r.losses}`))].sort();
const impossible = buckets.filter((b) => {
  const [x, y] = b.split("-").map(Number);
  return x + y > ROUNDS || x > ROUNDS - 1 || y > ROUNDS - 1;
});
ok(!impossible.length, "no impossible bucket appears", impossible.join(", "));
console.log(`         (buckets after: ${buckets.join("  ")})`);

/* The specific catastrophe: one bucket holding both advancing and eliminated. */
const mixed = buckets.find((b) => b === "3-3");
ok(!mixed, "no 3-3 bucket mixing advancing and eliminated teams");

/* And the records must be UNCHANGED — the elimination round is not a Swiss round. */
const changed = after.filter((r) => {
  const b = endOfSwiss.find((x) => x.team === r.team);
  return b && (b.wins !== r.wins || b.losses !== r.losses);
});
ok(!changed.length, "Swiss records are untouched by elimination results",
   changed.map((r) => r.team).join(", "));

/* ---- 4. the section renders, and only once fixtures exist ---- */
const rendered = w.renderGroups(clone);
ok(/Elimination Round/.test(rendered), "the elimination section renders");
ok(/sw-elim/.test(rendered), "it has its own container, separate from the Swiss buckets");
for (const t of winners.slice(0, 2)) {
  ok(rendered.includes(t), `${t} appears on the board`);
}

const noElim = JSON.parse(JSON.stringify(data));
noElim.groupStage.eliminationMatches = [];
ok(!/Elimination Round/.test(w.renderGroups(noElim)),
   "no empty section when there are no elimination fixtures");

/* ---- 5. THE STATE THAT ACTUALLY SHIPS ----
   The first version of this file tested eliminationMatches = [] and the fully
   played case, and never once rendered unmodified data.json — which is the only
   state that was live. data.json has carried five TBD placeholders all along, so
   the "no fixtures" guard was never the guard it claimed to be: it put five
   identical "TBD vs TBD" cards, each with a working notification bell, on the
   board during the Swiss. */
const today = w.renderGroups(data);
ok(/Elimination Round/.test(today), "the heading shows during the Swiss (fixtures exist)");
const tbdCards = (today.match(/data-teams="TBD TBD"/g) || []).length;
ok(tbdCards === 0, "no empty TBD-vs-TBD cards are rendered before the draw", `${tbdCards} found`);
const bells = (today.match(/data-notif="el-/g) || []).length;
ok(bells === 0, "no notification bells on undrawn fixtures", `${bells} found`);
ok(/Drawn once the Swiss rounds finish/.test(today), "it says the pairings are not drawn yet");

/* ---- 5b. the pip strip must agree with the record beside it ----
   Every gs- match carries a real `scheduled`; every el- match has
   scheduled:null. Sorting the team's matches by date made `null||0` the epoch,
   so the elimination round sorted BEFORE round 1, pushed the Swiss run right,
   and round 5 fell off the ROUNDS-long strip. Rows then showed a pip sequence
   that contradicted their own header — a 3-2 team above four wins. */
const played = w.renderGroups(clone);
let contradictions = 0;
for (const r of after) {
  const esc = r.team.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`data-team="${esc}"[\\s\\S]{0,400}?sw-tpips[^>]*>([\\s\\S]*?)</span>`).exec(played);
  if (!m) continue;
  const pw = (m[1].match(/class="w"/g) || []).length;
  const pl = (m[1].match(/class="l"/g) || []).length;
  if (pw !== r.wins || pl !== r.losses) {
    contradictions++;
    console.log(`         ${r.team}: record ${r.wins}-${r.losses}, pips ${pw}W-${pl}L`);
  }
}
ok(contradictions === 0, "every pip strip matches the record printed beside it",
   contradictions ? `${contradictions} rows contradict themselves` : "");

/* And the sixth game must not be a pip at all — the strip is the Swiss run. */
const maxPips = Math.max(...after.map((r) => {
  const esc = r.team.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`data-team="${esc}"[\\s\\S]{0,400}?sw-tpips[^>]*>([\\s\\S]*?)</span>`).exec(played);
  return m ? (m[1].match(/class="[wl]"/g) || []).length : 0;
}));
ok(maxPips <= ROUNDS, `no strip shows more than ${ROUNDS} marks`, `max ${maxPips}`);

/* ---- 6. the live indicator must survive the elimination round ----
   Narrowing isGroup to Swiss-only killed this: ten of sixteen rows would have
   shown a stale round-5 result with no live marker, on the evening the
   elimination round is actually being played. */
const live = JSON.parse(JSON.stringify(clone));
const lm = (live.groupStage.eliminationMatches || [])[0];
lm.status = "live";
lm.teamA = { name: winners[0], score: 1 };
lm.teamB = { name: losers[0], score: 0 };
const liveOut = w.renderGroups(live);
const row = new RegExp(`<div class="sw-team[^"]*"[^>]*data-team="${winners[0]}"`).exec(liveOut);
ok(!!row, `${winners[0]} still has a row on the board`);
ok(/sw-team is-live/.test(liveOut), "a team playing its elimination match is marked live on the board");
ok(liveOut.includes(losers[0]), "its live opponent is named");

console.log(fail ? `\n${fail} CHECK(S) FAILED` : "\nall checks pass");
process.exit(fail ? 1 : 0);
