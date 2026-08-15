/* A refresh must only rebuild the page when something a reader can see changed.
 *
 * Run: node tools/test_refresh_path.js        (needs jsdom)
 *
 * WHY THIS EXISTS
 *
 * refreshNow() picks between a full render() — which throws away and rebuilds
 * the entire page — and updateLiveRail(), which touches only the rail. The
 * decision is `structuralChange`, computed by diffing two stripVolatile()
 * copies.
 *
 * stripVolatile only ever scrubbed the BRACKET. Every live match until 20 Aug is
 * in the group stage, and the published kickoff times slide by minutes whenever
 * a series overruns, which is constantly. Measured across 63 consecutive real
 * data.json versions: 56 of 63 updates forced a full rebuild that changed
 * nothing visible. That is what made the page blink, stole the caret out of the
 * search box, and stacked duplicate listeners and network calls.
 *
 * The invariant runs BOTH ways, and the second half is the one that matters:
 * masking must not hide a real change. A match starting or finishing alters the
 * standings, so it must still repaint.
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

const dom = new JSDOM("<!doctype html><html><body><div id='app'></div></body></html>",
  { url: "https://dota2tileague.com/", runScripts: "dangerously", pretendToBeVisual: true });
const w = dom.window;
w.fetch = () => Promise.resolve({ ok: false, json: async () => ({}), text: async () => "" });
w.scrollTo = () => {}; w.console.error = () => {};
w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
{ const s = w.document.createElement("script"); s.textContent = script; w.document.body.appendChild(s); }

/* Exactly the expression refreshNow uses. */
const rebuilds = (a, b) => JSON.stringify(w.stripVolatile(a)) !== JSON.stringify(w.stripVolatile(b));
const clone = () => JSON.parse(JSON.stringify(data));

/* Walk every match in the file, wherever it lives. */
function eachMatch(d, fn) {
  (d.groupStage.rounds || []).forEach((r) => (r.matches || []).forEach(fn));
  (d.groupStage.eliminationMatches || []).forEach(fn);
  const br = (d.bracket || {}).rounds || {};
  [...(br.upper || []), ...(br.lower || [])].forEach((r) => (r.matches || []).forEach(fn));
  if (d.bracket && d.bracket.grandFinal) fn(d.bracket.grandFinal);
  (d.qualifiers || []).forEach((q) => (q.matches || []).forEach(fn));
}

/* ---------- 1. noise must NOT rebuild ------------------------------------ */
console.log("noise does not rebuild the page");
{
  /* Kickoff drift — the dominant real-world trigger, and the one thing this is
     allowed to swallow. */
  const drift = clone();
  let moved = 0;
  eachMatch(drift, (m) => {
    if (m.scheduled && moved < 2) { m.scheduled = new Date(Date.parse(m.scheduled) + 5 * 60000).toISOString(); moved++; }
  });
  ok(moved > 0, "found scheduled times to drift", String(moved));
  ok(!rebuilds(drift, data), "a five-minute kickoff slide does NOT rebuild the page");

  /* The updater stamp alone. */
  const stamped = clone();
  stamped.meta.lastUpdated = new Date().toISOString();
  ok(!rebuilds(stamped, data), "a new lastUpdated alone does NOT rebuild");
}

/* ---------- 1b. a REAL postponement must still repaint -------------------
   The second attempt at this blanked `scheduled` outright, which swallowed a
   two-hour postponement as readily as a five-minute nudge — and liveSignature
   does not carry `scheduled` either, so nothing repainted and the site showed
   the old time indefinitely. The mask rounds to 15 minutes instead, so drift
   stays inside a bucket and a real move crosses one. */
console.log("\nbut a real postponement still repaints");
{
  const late = clone();
  let n = 0;
  eachMatch(late, (m) => {
    if (m.scheduled && n < 1) { m.scheduled = new Date(Date.parse(m.scheduled) + 2 * 3600 * 1000).toISOString(); n++; }
  });
  ok(n > 0, "found a fixture to postpone");
  ok(rebuilds(late, data), "a two-hour postponement DOES rebuild");
}

/* ---------- 1c. live scores are NOT masked ------------------------------
   THIS ASSERTION IS INVERTED FROM ITS FIRST VERSION, and the reason matters.
   It originally asserted that a live score tick takes the cheap path — I wrote
   the test to agree with the code, and both were wrong. The cheap path repaints
   #liveRail and nothing else, but a live score ALSO shows on the Swiss board's
   per-team line ("● 0–1 vs X · 34'") and on the elimination-round and bracket
   cards, none of which are in the rail. Masking froze them until an unrelated
   match started or finished; in an elimination round or a grand final that can
   be the better part of an hour. */
console.log("\na live score change must repaint — it is on the board, not just the rail");
{
  const named = [];
  eachMatch(data, (m) => { if ((m.teamA || {}).name && m.teamA.name !== "TBD") named.push(m.id); });
  const target = named[0];
  const at = (score) => {
    const d = clone();
    eachMatch(d, (m) => { if (m.id === target) { m.status = "live"; m.teamA.score = score; m.teamB.score = 0; } });
    return d;
  };
  ok(!!target && rebuilds(at(1), at(0)),
     "a live score tick DOES rebuild, so the group board cannot go stale", target);
}

/* ---------- 2. real change MUST rebuild ---------------------------------- */
console.log("\nbut a real change still does");
{
  /* CONSTRUCT the before/after pair rather than hunting for one in today's
     data. The first draft looked for a live or upcoming match to transition;
     once the group stage finished there were none left — every named match is
     completed and everything else is TBD — so both assertions silently reported
     "not found" instead of testing anything. A test that only works while the
     tournament is mid-flight is no test at all. */
  const named = [];
  eachMatch(data, (m) => { if ((m.teamA || {}).name && m.teamA.name !== "TBD") named.push(m.id); });
  ok(named.length > 0, "found a named fixture to transition", String(named.length));
  const target = named[0];

  const withStatus = (status, sa, sb) => {
    const d = clone();
    eachMatch(d, (m) => {
      if (m.id !== target) return;
      m.status = status;
      if (m.teamA) m.teamA.score = sa;
      if (m.teamB) m.teamB.score = sb;
    });
    return d;
  };

  /* live -> completed. The standings move, so the page must repaint. */
  ok(rebuilds(withStatus("completed", 2, 0), withStatus("live", 1, 0)),
     "a match FINISHING rebuilds (the standings moved)", target);

  /* upcoming -> live. The live markers appear. */
  ok(rebuilds(withStatus("live", 0, 0), withStatus("upcoming", null, null)),
     "a match STARTING rebuilds", target);

  /* The control that keeps the two assertions above honest: something that must
     NOT rebuild. Kickoff drift is that thing — if even this rebuilt, the two
     above would pass simply because every edit rebuilds. */
  const same = clone(), nudged = clone();
  let bumped = 0;
  eachMatch(nudged, (m) => {
    if (m.scheduled && bumped < 1) { m.scheduled = new Date(Date.parse(m.scheduled) + 3 * 60000).toISOString(); bumped++; }
  });
  ok(bumped > 0 && !rebuilds(nudged, same),
     "…while a three-minute kickoff nudge still does not", `${bumped} moved`);

  /* A pairing being drawn. */
  const drawn = clone();
  let did = null;
  eachMatch(drawn, (m) => {
    if (!did && (m.teamA || {}).name === "TBD") { m.teamA.name = "Team Spirit"; m.teamB.name = "Aurora Gaming"; did = m.id; }
  });
  if (did) ok(rebuilds(drawn, data), "a pairing being DRAWN rebuilds", did);

  /* Standings changing. */
  const st = clone();
  if ((st.groupStage.standings || []).length) {
    st.groupStage.standings[0].wins = (st.groupStage.standings[0].wins || 0) + 1;
    ok(rebuilds(st, data), "a standings change rebuilds");
  }
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall good");
process.exit(fail ? 1 : 0);
