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
  const live = w.liveMatchesOf(data).filter((m) => m.status === "live");
  console.log(`         (${live.length} live right now)`);

  /* A live score tick, wherever the live match happens to be. */
  if (live.length) {
    const d = clone();
    let done = false;
    eachMatch(d, (m) => { if (!done && m.status === "live" && m.teamA) { m.teamA.score = (m.teamA.score || 0) + 1; done = true; } });
    ok(done && !rebuilds(d, data), "a live score tick takes the cheap path");
  } else {
    /* Manufacture one so this never silently skips. */
    const base = clone();
    let id = null;
    eachMatch(base, (m) => { if (!id && (m.teamA || {}).name && m.teamA.name !== "TBD") { m.status = "live"; m.teamA.score = 0; m.teamB.score = 0; id = m.id; } });
    const d = JSON.parse(JSON.stringify(base));
    eachMatch(d, (m) => { if (m.id === id) m.teamA.score = 1; });
    ok(!!id && !rebuilds(d, base), "a live score tick takes the cheap path (simulated)");
  }

  /* Kickoff drift — the dominant real-world trigger. */
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

  /* And the control: the same match, same status, only the score moving, must
     NOT rebuild — otherwise the two assertions above would pass simply because
     any edit rebuilds. */
  ok(!rebuilds(withStatus("live", 2, 0), withStatus("live", 1, 0)),
     "…while a score change WITHIN a live match still does not", target);

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
