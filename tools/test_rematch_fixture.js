/* A result may never be attached to a fixture that had not started yet.
 *
 * Run: node tools/test_rematch_fixture.js        (needs jsdom)
 *
 * WHY THIS EXISTS
 *
 * On 15 Aug the site showed Aurora Gaming as having already won their
 * elimination match against BoomBoys — filled sixth bubble, "beat BoomBoys 2-0"
 * on the row, the match listed twice in the team panel — while that match had
 * not been played and was still open to predict. The owner spotted it.
 *
 * data.json was correct. The server-side matcher was correct. The client did it:
 *
 *   - Aurora beat BoomBoys 2-0 in round 4, on the morning of the 15th
 *   - that evening the same two were drawn against each other AGAIN in the
 *     elimination round, scheduled 02:00 on the 16th
 *   - tiMergedMatches replays every series from the live feed and matches it to
 *     a fixture BY TEAM PAIR, and now two fixtures matched
 *   - chooseFixture preferred an UNDECIDED fixture, so it skipped the group
 *     match precisely because that one was already correctly settled, and wrote
 *     the round-4 score onto tomorrow's match
 *
 * The fix is time: a series starts at or after its fixture's scheduled time —
 * delays push it later, never earlier — so a fixture scheduled well after the
 * series began cannot be the one it belongs to.
 *
 * This is the same shape as the server's _pick_series guard, which is why that
 * one exists. Reachable again on 20 Aug, when two teams can meet in the upper
 * bracket and again in the lower bracket or the grand final.
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

function boot(feed) {
  const dom = new JSDOM("<!doctype html><html><body><div id='app'></div></body></html>",
    { url: "https://dota2tileague.com/", runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window;
  w.fetch = () => Promise.resolve({ ok: false, json: async () => ({}), text: async () => "" });
  w.scrollTo = () => {}; w.console.error = () => {};
  w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  const s = w.document.createElement("script"); s.textContent = script;
  w.document.body.appendChild(s);
  /* LIVE_FEED is a top-level `let`, so it is not a window property — assigning
     w.LIVE_FEED would create an unrelated global and prove nothing. */
  w.eval("LIVE_FEED=" + JSON.stringify(feed));
  return w;
}

const SEC = 1000;
const iso = (ms) => new Date(ms).toISOString();

/* Build the exact situation: one pairing, two fixtures, one played series. */
function scenario({ playedAt, groupAt, laterAt }) {
  return {
    data: {
      meta: { dates: {} },
      groupStage: {
        rounds: [{ name: "Round 4", matches: [{
          id: "gs-r4-m3", scheduled: iso(groupAt), status: "completed", bestOf: 3,
          teamA: { name: "BoomBoys", score: 0 }, teamB: { name: "Aurora Gaming", score: 2 },
        }] }],
        eliminationMatches: [{
          id: "el-r1m2", scheduled: iso(laterAt), status: "upcoming", bestOf: 3,
          teamA: { name: "Aurora Gaming", score: null }, teamB: { name: "BoomBoys", score: null },
        }],
        standings: [],
      },
      bracket: { rounds: { upper: [], lower: [] } },
      qualifiers: [],
      teams: [],
    },
    feed: { liveMatches: [], events: [], tiSeries: [
      { a: "Aurora Gaming", b: "BoomBoys", sa: 2, sb: 0, start: Math.floor(playedAt / 1000) },
    ] },
  };
}

const DAY = 24 * 3600 * SEC;
const T0 = Date.parse("2026-08-15T06:00:00Z");

/* ---------- 1. the exact bug ------------------------------------------- */
console.log("a series played today does not settle a fixture scheduled tomorrow");
{
  const { data: d, feed } = scenario({ playedAt: T0, groupAt: T0 - 600 * SEC, laterAt: T0 + DAY });
  const w = boot(feed);
  const merged = w.tiMergedMatches(d);
  const elim = merged.find((m) => m.id === "el-r1m2");
  const grp = merged.find((m) => m.id === "gs-r4-m3");

  ok(elim.teamA.score == null && elim.teamB.score == null,
     "tomorrow's rematch carries no score",
     `${elim.teamA.score}-${elim.teamB.score}`);
  ok(elim.status === "upcoming", "…and is still upcoming", elim.status);
  ok(grp.teamA.score === 0 && grp.teamB.score === 2,
     "…while the match it actually belongs to keeps its result",
     `${grp.teamA.score}-${grp.teamB.score}`);
}

/* ---------- 2. it must still fill a fixture it DOES belong to ----------
   Otherwise the fix is "ignore the feed", which would reintroduce the lag this
   merge exists to paper over. */
console.log("\nbut it still settles a fixture whose time it matches");
{
  /* Same pairing, but the group fixture has NO score yet — the schedule lags. */
  const { data: d, feed } = scenario({ playedAt: T0, groupAt: T0 - 600 * SEC, laterAt: T0 + DAY });
  d.groupStage.rounds[0].matches[0].teamA.score = null;
  d.groupStage.rounds[0].matches[0].teamB.score = null;
  d.groupStage.rounds[0].matches[0].status = "upcoming";
  const w = boot(feed);
  const merged = w.tiMergedMatches(d);
  const grp = merged.find((m) => m.id === "gs-r4-m3");
  const elim = merged.find((m) => m.id === "el-r1m2");
  ok(grp.teamA.score === 0 && grp.teamB.score === 2,
     "the lagging group fixture IS filled in from the feed",
     `${grp.teamA.score}-${grp.teamB.score}`);
  ok(grp.status === "completed", "…and promoted to completed", grp.status);
  ok(elim.teamA.score == null, "…and the future rematch is still untouched");
}

/* ---------- 3. tomorrow's series settles tomorrow's fixture ------------- */
console.log("\nand when the rematch is actually played, it lands correctly");
{
  const { data: d, feed } = scenario({ playedAt: T0, groupAt: T0 - 600 * SEC, laterAt: T0 + DAY });
  /* Both series now exist, newest last — the order tiMergedMatches sorts into. */
  feed.tiSeries = [
    { a: "Aurora Gaming", b: "BoomBoys", sa: 2, sb: 0, start: Math.floor(T0 / 1000) },
    { a: "Aurora Gaming", b: "BoomBoys", sa: 1, sb: 2, start: Math.floor((T0 + DAY) / 1000) },
  ];
  const w = boot(feed);
  const merged = w.tiMergedMatches(d);
  const grp = merged.find((m) => m.id === "gs-r4-m3");
  const elim = merged.find((m) => m.id === "el-r1m2");
  ok(grp.teamA.score === 0 && grp.teamB.score === 2, "round 4 keeps its own result",
     `${grp.teamA.score}-${grp.teamB.score}`);
  ok(elim.teamA.score === 1 && elim.teamB.score === 2,
     "the elimination match gets the elimination result, not round 4's",
     `${elim.teamA.score}-${elim.teamB.score}`);
}

/* ---------- 4. a missing schedule must not swallow a result ------------- */
console.log("\na fixture with no scheduled time still gets filled");
{
  const { data: d, feed } = scenario({ playedAt: T0, groupAt: T0 - 600 * SEC, laterAt: T0 + DAY });
  d.groupStage.rounds[0].matches[0].scheduled = null;
  d.groupStage.rounds[0].matches[0].teamA.score = null;
  d.groupStage.rounds[0].matches[0].teamB.score = null;
  d.groupStage.rounds[0].matches[0].status = "upcoming";
  d.groupStage.eliminationMatches[0].scheduled = null;
  const w = boot(feed);
  const merged = w.tiMergedMatches(d);
  const settled = merged.filter((m) => (m.teamA || {}).score != null).length;
  ok(settled >= 1, "the result is not lost when times are unknown", `${settled} fixture(s) settled`);
}

/* ---------- 5. against the REAL file: no elimination fixture invents one -- */
console.log("\nagainst the live data.json and an empty feed");
{
  const w = boot({ liveMatches: [], events: [], tiSeries: [] });
  const merged = w.tiMergedMatches(data);
  const bogus = merged.filter((m) => /^el-/.test(m.id || ""))
    .filter((m) => {
      const src = (data.groupStage.eliminationMatches || []).find((x) => x.id === m.id) || {};
      return (m.teamA || {}).score != null && (src.teamA || {}).score == null;
    });
  ok(bogus.length === 0, "no elimination fixture gains a score the data does not have",
     bogus.map((m) => m.id).join(", "));
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall good");
process.exit(fail ? 1 : 0);
