/* The champion's road must be complete, in order, and honest about losses.
 *
 * Run: node tools/test_road_to_title.js        (needs jsdom)
 *
 * WHY THIS EXISTS
 *
 * road.html is the reason data.json's per-match history is never truncated
 * anywhere upstream. If a stage is silently dropped the page still renders and
 * still looks right - it just shows a shorter run than the team actually had,
 * and nobody would notice. So this asserts the road against a fixture whose
 * correct answer is known by construction.
 *
 * It also simulates the state that does NOT exist yet: a completed grand final.
 * The champion path cannot be exercised against live data until 23 Aug 2026, so
 * if it is only tested then, it is tested in production. Same trap as
 * test_elim_confirmed, which went red on correct code the morning the
 * elimination round was first played.
 *
 * MUTATION RESULTS (2026-08-16), against road.html:
 *   drop the elimination round   -> RED (6)
 *   drop the grand final         -> RED (7)
 *   show only wins               -> RED (7)
 *   label every team champion    -> RED (2)
 *   remove the chronological sort -> GREEN, and that is EXPECTED, not a gap.
 *     collect() already pushes stage by stage, so the array arrives sorted and
 *     the sort is defensive. Contriving a fixture to make it fail would be
 *     testing the test. Recorded rather than papered over: if collect() is ever
 *     changed to gather matches in another order, the sort becomes load-bearing
 *     and this note is the warning that nothing here covers it.
 */
const fs = require("fs");
const path = require("path");
let JSDOM;
try { ({ JSDOM } = require("jsdom")); }
catch (e) { console.error("CANNOT RUN: jsdom missing.  npm install"); process.exit(1); }

const ROOT = path.dirname(__dirname);
const HTML = fs.readFileSync(path.join(ROOT, "road.html"), "utf8");

let fail = 0;
const ok = (cond, msg, extra) => {
  console.log((cond ? "  ok   " : "  FAIL ") + msg + (extra ? "   " + extra : ""));
  if (!cond) fail++;
};

/* A tournament whose right answer we know: ACE go 2-3 in the group stage,
   survive the elimination round, then win four straight including the final.
   Nine series, and the fourth of them is a loss they came back from. */
const M = (a, sa, b, sb, when) => ({
  id: a + "-" + b, bestOf: 3, status: "completed", scheduled: when,
  teamA: { name: a, score: sa }, teamB: { name: b, score: sb },
});
const FIXTURE = {
  meta: { title: "Test" },
  logos: { ACE: "https://example.test/ace.png", Rival: "https://example.test/rival.png" },
  groupStage: {
    standings: [{ team: "ACE" }],
    rounds: [
      { matches: [M("ACE", 2, "Rival", 0, "2026-08-13T11:00:00+08:00"), M("Other", 2, "Filler", 1, "2026-08-13T11:00:00+08:00")] },
      { matches: [M("Foe", 2, "ACE", 1, "2026-08-14T11:00:00+08:00")] },
      { matches: [M("ACE", 2, "Third", 1, "2026-08-15T11:00:00+08:00")] },
      { matches: [M("Fourth", 2, "ACE", 0, "2026-08-15T15:00:00+08:00")] },
      { matches: [M("ACE", 0, "Fifth", 2, "2026-08-16T11:00:00+08:00")] },
    ],
    eliminationMatches: [M("ACE", 2, "Sixth", 1, "2026-08-16T19:00:00+08:00")],
  },
  bracket: {
    rounds: {
      upper: [{ name: "Upper Bracket Quarterfinals", matches: [M("ACE", 2, "Seventh", 0, "2026-08-20T05:00:00+08:00")] }],
      lower: [{ name: "Lower Bracket Round 1", matches: [M("ACE", 2, "Eighth", 1, "2026-08-21T05:00:00+08:00")] }],
    },
    grandFinal: { id: "gf", bestOf: 5, status: "completed", scheduled: "2026-08-23T13:00:00+08:00",
      teamA: { name: "ACE", score: 3 }, teamB: { name: "Ninth", score: 2 } },
  },
};

async function render(query) {
  const dom = new JSDOM(HTML, {
    url: "https://dota2tileague.com/road.html" + (query || ""),
    runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = async () => ({ ok: true, json: async () => JSON.parse(JSON.stringify(FIXTURE)) });
    },
  });
  await new Promise((r) => setTimeout(r, 220));
  return dom;
}

(async () => {
  console.log("the champion is found without being asked for");
  let dom = await render("");
  let doc = dom.window.document;
  ok(/ACE/.test(doc.querySelector("h1")?.textContent || ""),
     "the grand-final winner is the default team", doc.querySelector("h1")?.textContent);
  ok(/Champions/i.test(doc.querySelector(".eyebrow")?.textContent || ""),
     "and is labelled as champions", doc.querySelector(".eyebrow")?.textContent);

  console.log("\nthe road is COMPLETE — every stage, nothing truncated");
  const rows = [...doc.querySelectorAll(".m")];
  ok(rows.length === 9, "nine series: 5 group + 1 elimination + 2 bracket + the final", String(rows.length));
  const stages = [...doc.querySelectorAll("h2")].map((h) => h.textContent);
  ["round 1", "round 5", "Elimination", "Upper Bracket", "Lower Bracket", "Grand final"]
    .forEach((s) => ok(stages.some((x) => x.toLowerCase().includes(s.toLowerCase())),
      `stage present: ${s}`, ""));

  console.log("\nin the order they were played");
  const opps = rows.map((r) => r.querySelector(".opp span").textContent);
  ok(opps[0] === "Rival" && opps[opps.length - 1] === "Ninth",
     "first opponent is round 1, last is the grand final", opps.join(" > "));

  console.log("\nlosses are shown, not hidden");
  ok(rows.filter((r) => r.classList.contains("l")).length === 3,
     "all three group-stage losses appear", "");
  ok(rows.filter((r) => r.classList.contains("w")).length === 6, "and six wins", "");

  console.log("\nthe numbers add up");
  const stat = (label) => {
    const el = [...doc.querySelectorAll(".stat")]
      .find((s) => new RegExp(label, "i").test(s.querySelector(".l").textContent));
    return el ? el.querySelector(".n").textContent.trim() : null;
  };
  ok(stat("Series record") === "6–3", "series record 6-3", stat("Series record"));
  ok(stat("Longest win streak") === "4", "longest win streak is 4 (elim + 2 bracket + final)",
     stat("Longest win streak"));
  ok(stat("Losses they came back from") === "3",
     "the comeback tile appears because they lost and still won", stat("Losses they came back from"));
  /* Series lengths: 2 3 3 2 2 3 2 3 5 = 25 individual games.
     (Counted wrong by hand the first time - the test caught me, not the code.) */
  ok(stat("Games played") === "25", "25 individual games", stat("Games played"));

  console.log("\nanother team can be asked for, and is not called champion");
  dom = await render("?team=Rival");
  doc = dom.window.document;
  ok(/Rival/.test(doc.querySelector("h1")?.textContent || ""), "shows the requested team", "");
  ok(!/Champions/i.test(doc.querySelector(".eyebrow")?.textContent || ""),
     "and does NOT claim they are champions", doc.querySelector(".eyebrow")?.textContent);

  console.log("\nbefore a champion exists it must not invent one");
  const noFinal = JSON.parse(JSON.stringify(FIXTURE));
  noFinal.bracket.grandFinal.status = "upcoming";
  noFinal.bracket.grandFinal.teamA = { name: "TBD", score: null };
  noFinal.bracket.grandFinal.teamB = { name: "TBD", score: null };
  const dom2 = new JSDOM(HTML, {
    url: "https://dota2tileague.com/road.html", runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(w) { w.fetch = async () => ({ ok: true, json: async () => noFinal }); },
  });
  await new Promise((r) => setTimeout(r, 220));
  const d2 = dom2.window.document;
  ok(!/Champions/i.test(d2.querySelector(".eyebrow")?.textContent || ""),
     "no champion label while the final is unplayed", d2.querySelector(".eyebrow")?.textContent);
  ok(![...d2.querySelectorAll(".opp span")].some((s) => /TBD/i.test(s.textContent)),
     "and a TBD placeholder is never listed as an opponent", "");

  console.log("\nnothing threw");
  ok(true, "rendered clean", "");

  console.log();
  console.log(fail ? fail + " FAILURE(S)" : "all good");
  process.exit(fail ? 1 : 0);
})();
