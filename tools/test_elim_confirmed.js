/* The elimination round lists who is already in it — and the group stage does
 * not move a pixel.
 *
 * Run: node tools/test_elim_confirmed.js        (needs jsdom)
 *
 * WHY THIS EXISTS
 *
 * The section used to say "drawn once the Swiss rounds finish" and show
 * nothing, while eight teams were already mathematically certain to be in it.
 * With one Swiss game left, every 2-2 team plays this round whichever way that
 * game goes — the page had the information and withheld it.
 *
 * It now lists them with a ROUNDS+1 strip: the Swiss run, then this round. A
 * team still in its round-5 game shows four marks and TWO blanks — one for
 * that pending result, one for the pending elimination match.
 *
 * THE CONSTRAINT THAT MATTERS: the group stage buckets must be untouched. Their
 * strip is exactly ROUNDS long, and infoFor() carries a comment warning that a
 * sixth mark would push round 1 off the front of it. The elimination result is
 * therefore returned SEPARATELY (elimPip) rather than pushed into pips. The
 * first assertion below renders the group stage before and after and compares
 * byte for byte — if that ever fails, the sixth bubble has leaked upstream.
 */
const fs = require("fs");
const path = require("path");

let JSDOM;
try { ({ JSDOM } = require("jsdom")); }
catch (e) { console.error("CANNOT RUN: jsdom missing.  npm install"); process.exit(1); }

const ROOT = path.join(__dirname, "..");
const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data.json"), "utf8"));
const ROUNDS = (data.groupStage.rounds || []).length || 5;

let fail = 0;
const ok = (c, m, x) => { console.log((c ? "  ok   " : "  FAIL ") + m + (x ? "   " + x : "")); if (!c) fail++; };

function boot(file) {
  const html = fs.readFileSync(file, "utf8");
  const script = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/.exec(html)[1].replace(/\ninit\(\);?/, "\n");
  const dom = new JSDOM("<!doctype html><html><body><div id='app'></div></body></html>",
    { url: "https://dota2tileague.com/", runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window;
  w.fetch = () => Promise.resolve({ ok: false, json: async () => ({}), text: async () => "" });
  w.scrollTo = () => {};
  w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  const errs = [];
  w.console.error = (...a) => { if (!/[Ss]upabase/.test(String(a[0]))) errs.push(String(a[0])); };
  const s = w.document.createElement("script");
  s.textContent = script;
  w.document.body.appendChild(s);
  return { w, errs };
}

const render = (w, d) => {
  const host = w.document.createElement("div");
  host.innerHTML = w.renderGroups(d);
  w.document.body.appendChild(host);
  return host;
};
/* The buckets only — everything above the elimination section. */
const bucketsHTML = (host) => [...host.querySelectorAll(".sw-bucket")].map((b) => b.outerHTML).join("\n");

const { w, errs } = boot(path.join(ROOT, "index.html"));

/* The format, stated independently of the code. In a fixed R-round Swiss where
   the top slice advances, R-1 wins is a direct playoff slot and R-1 losses is
   out. Deliberately NOT read from the page: swissTarget() is a top-level const
   arrow, so it is not a window property anyway, and a test that imports the
   implementation's own answer is only checking that the code equals itself.
   Cross-checked against the rendered board immediately below. */
const TARGET = Math.max(1, ROUNDS - 1);

console.log("the format the page renders matches the format this test assumes");
{
  const host = render(w, data);
  const rec = (el) => (el.querySelector(".sw-brec") || {}).textContent || "";
  const adv = [...host.querySelectorAll(".sw-bucket.is-adv")].map((b) => +rec(b).split(/[–-]/)[0]);
  const out = [...host.querySelectorAll(".sw-bucket.is-out")].map((b) => +rec(b).split(/[–-]/)[1]);
  ok(adv.every((n) => n >= TARGET), `every "qualified" bucket is at ${TARGET}+ wins`, adv.join(","));
  ok(out.every((n) => n >= TARGET), `every "eliminated" bucket is at ${TARGET}+ losses`, out.join(","));
  host.remove();
}

/* ---------- 1. the group stage is untouched ------------------------------ */
console.log("\nthe group stage did not move");
{
  const host = render(w, data);
  const rows = [...host.querySelectorAll(".sw-bucket .sw-team")];
  ok(rows.length > 0, "group-stage rows render", String(rows.length));
  const wrong = rows.filter((r) => r.querySelectorAll(".sw-tpips i").length !== ROUNDS);
  ok(wrong.length === 0, `every group-stage row still has exactly ${ROUNDS} bubbles`,
     wrong.length ? `${wrong.length} row(s) differ` : "");
  const leaked = [...host.querySelectorAll(".sw-bucket .sw-tpips i.is-elim")];
  ok(leaked.length === 0, "no elimination bubble leaked into a bucket", String(leaked.length));
  host.remove();
}

/* Counting bubbles is NOT enough, and I proved that the hard way: the strip is
   built with Array.from({length:ROUNDS}) so it is always ROUNDS long no matter
   what pips contains. Appending the elimination result to pips therefore keeps
   the COUNT right while changing the CONTENT — a team with round 5 still to
   play has four marks and a blank, and the leak fills that blank with a result
   from a different stage entirely. The mutation survived the count check.
   So: on a state where elimination matches have been decided, every bucket row
   must have exactly as many filled bubbles as Swiss games it has played. */
console.log("\nand a decided elimination match does not fill a Swiss bubble");
{
  const s = w.computeGroupStandings(data).rows || [];
  const pool = s.filter((r) => {
    const left = Math.max(0, ROUNDS - (r.wins + r.losses));
    return r.wins < TARGET && r.losses < TARGET && (r.wins + left) < TARGET && (r.losses + left) < TARGET;
  }).map((r) => r.team);

  const played = JSON.parse(JSON.stringify(data));
  (played.groupStage.eliminationMatches || []).forEach((m, n) => {
    const a = pool[n * 2], b = pool[n * 2 + 1];
    if (!a || !b) return;
    m.teamA = { name: a, score: 2 }; m.teamB = { name: b, score: 0 };
    m.status = "completed"; m.bestOf = 3;
  });
  const decided = (played.groupStage.eliminationMatches || []).filter((m) => m.status === "completed").length;
  ok(decided > 0, "built a state with decided elimination matches", `${decided}`);

  const host = render(w, played);
  const st = {};
  s.forEach((r) => { st[r.team] = r; });
  const overfilled = [...host.querySelectorAll(".sw-bucket .sw-team")].filter((r) => {
    const team = r.querySelector(".sw-tname").textContent.trim();
    const rec = st[team]; if (!rec) return false;
    const filled = [...r.querySelectorAll(".sw-tpips i")].filter((i) => i.className.trim()).length;
    return filled !== rec.wins + rec.losses;
  }).map((r) => r.querySelector(".sw-tname").textContent.trim());
  ok(overfilled.length === 0,
     "each bucket row shows exactly its Swiss games, no more",
     overfilled.length ? `${overfilled.join(", ")} gained a bubble from another stage` : "");
  host.remove();
}

/* ---------- 2. the confirmed list is right ------------------------------- */
console.log("\nconfirmed teams");
{
  const host = render(w, data);
  const s = (w.computeGroupStandings(data).rows || []);
  const target = TARGET;
  /* Recomputed here independently of the page, so this is a check and not an
     echo of the same expression. */
  const expect = s.filter((r) => {
    const left = Math.max(0, ROUNDS - (r.wins + r.losses));
    if (r.wins >= target || r.losses >= target) return false;
    return (r.wins + left) < target && (r.losses + left) < target;
  }).map((r) => r.team).sort();

  const shown = [...host.querySelectorAll(".sw-elimteams .sw-tname")].map((n) => n.textContent.trim()).sort();
  ok(JSON.stringify(shown) === JSON.stringify(expect),
     "the listed teams are exactly those that can neither qualify nor be eliminated",
     `shown ${shown.length}, expected ${expect.length}`);

  /* Nobody already decided may appear. */
  const decided = s.filter((r) => r.wins >= target || r.losses >= target).map((r) => r.team);
  const wrongly = shown.filter((t) => decided.includes(t));
  ok(wrongly.length === 0, "no already-qualified or already-out team is listed", wrongly.join(", "));
  if (shown.length) console.log(`         (${shown.join(", ")})`);
  host.remove();
}

/* ---------- 3. six bubbles, and the blanks mean what they say ------------ */
console.log(`\nthe strip is ${ROUNDS}+1`);
{
  const host = render(w, data);
  const rows = [...host.querySelectorAll(".sw-elimteams .sw-team")];
  if (!rows.length) {
    ok(false, "there are confirmed rows to inspect", "none rendered");
  } else {
    const wrong = rows.filter((r) => r.querySelectorAll(".sw-tpips i").length !== ROUNDS + 1);
    ok(wrong.length === 0, `every row has ${ROUNDS + 1} bubbles`, wrong.length ? `${wrong.length} differ` : "");
    ok(rows.every((r) => r.querySelectorAll(".sw-tpips i.is-elim").length === 1),
       "exactly one of them is marked as this round's");
    ok(rows.every((r) => r.querySelector(".sw-tpips i:last-child").classList.contains("is-elim")),
       "and it is the last one");

    /* The blanks must match games actually outstanding — this is the thing the
       user described: four marks and two blanks while round 5 is being played. */
    const st = {};
    (w.computeGroupStandings(data).rows || []).forEach((r) => { st[r.team] = r; });
    const mismatched = rows.filter((r) => {
      const team = r.querySelector(".sw-tname").textContent.trim();
      const rec = st[team]; if (!rec) return true;
      const filled = [...r.querySelectorAll(".sw-tpips i")].filter((i) => i.className.replace("is-elim", "").trim()).length;
      return filled !== rec.wins + rec.losses;
    });
    ok(mismatched.length === 0,
       "filled bubbles equal games actually played; the rest are blank",
       mismatched.map((r) => r.querySelector(".sw-tname").textContent.trim()).join(", "));
  }
  host.remove();
}

/* ---------- 4. the sixth bubble fills when the match is played ----------- */
console.log("\nthe sixth bubble fills");
{
  const played = JSON.parse(JSON.stringify(data));
  const s = w.computeGroupStandings(data).rows || [];
  const target = TARGET;
  const pool = s.filter((r) => {
    const left = Math.max(0, ROUNDS - (r.wins + r.losses));
    return r.wins < target && r.losses < target && (r.wins + left) < target && (r.losses + left) < target;
  }).map((r) => r.team);

  if (pool.length >= 2 && (played.groupStage.eliminationMatches || []).length) {
    const m = played.groupStage.eliminationMatches[0];
    m.teamA = { name: pool[0], score: 2 }; m.teamB = { name: pool[1], score: 0 };
    m.status = "completed"; m.bestOf = 3;

    const host = render(w, played);
    const byName = {};
    [...host.querySelectorAll(".sw-elimteams .sw-team")].forEach((r) => {
      byName[r.querySelector(".sw-tname").textContent.trim()] = r;
    });
    const winner = byName[pool[0]], loser = byName[pool[1]];
    ok(!!winner && !!loser, "both teams still listed after their match", "");
    if (winner && loser) {
      ok(winner.querySelector(".sw-tpips i:last-child").classList.contains("w"),
         `${pool[0]} shows a win in the sixth bubble`,
         winner.querySelector(".sw-tpips i:last-child").className);
      ok(loser.querySelector(".sw-tpips i:last-child").classList.contains("l"),
         `${pool[1]} shows a loss in the sixth bubble`,
         loser.querySelector(".sw-tpips i:last-child").className);
    }
    /* And the group stage STILL has ROUNDS, not ROUNDS+1. */
    const bad = [...host.querySelectorAll(".sw-bucket .sw-team")]
      .filter((r) => r.querySelectorAll(".sw-tpips i").length !== ROUNDS);
    ok(bad.length === 0, "group-stage strips unchanged by an elimination result", String(bad.length));
    host.remove();
  } else {
    ok(false, "could build a played elimination match", "not enough confirmed teams");
  }
}

console.log("\nnothing threw");
ok(errs.length === 0, "no console errors", errs.slice(0, 2).join(" | "));

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall good");
process.exit(fail ? 1 : 0);

/* ---------- 6. the Swiss board must describe the SWISS ------------------
   infoFor keeps elimination results out of `pips` but `last` had no such
   guard, and lineFor is shared by the bucket rows and the elimination rows.
   So the moment the elimination round was played, a 3-2 bucket row whose five
   marks ended in a LOSS announced "beat BoomBoys 2-0" — a result from a
   different stage. The record, the marks and the sentence all disagreed on one
   row. This is reachable on 16 Aug. */
console.log("\nthe Swiss rows describe the Swiss, even after the elimination round");
{
  const played = JSON.parse(JSON.stringify(data));
  (played.groupStage.eliminationMatches || []).forEach((m) => {
    if (!m.teamA || m.teamA.name === "TBD") return;
    m.status = "completed"; m.teamA.score = 2; m.teamB.score = 0;
  });
  const decided = (played.groupStage.eliminationMatches || []).filter((m) => m.status === "completed");
  ok(decided.length > 0, "built a played-out elimination round", `${decided.length} matches`);

  const host = render(w, played);
  /* Every bucket row's line must name an opponent it actually met in the SWISS. */
  const swissOpp = {};
  (played.groupStage.rounds || []).forEach((r) => (r.matches || []).forEach((m) => {
    const a = (m.teamA || {}).name, b = (m.teamB || {}).name;
    if (!a || !b || a === "TBD") return;
    (swissOpp[a] = swissOpp[a] || []).push(b);
    (swissOpp[b] = swissOpp[b] || []).push(a);
  }));
  const wrong = [];
  [...host.querySelectorAll(".sw-bucket .sw-team")].forEach((row) => {
    const team = row.querySelector(".sw-tname").textContent.trim();
    const line = row.querySelector(".sw-tline").textContent.replace(/\s+/g, " ").trim();
    const m = /(?:beat|lost to)\s+(.+?)\s+\d+[–-]\d+/.exec(line);
    if (!m) return;
    if (!(swissOpp[team] || []).includes(m[1])) wrong.push(`${team}: "${line}"`);
  });
  ok(wrong.length === 0,
     "no bucket row reports a result against a team it never met in the Swiss",
     wrong.slice(0, 3).join(" | "));

  /* And the last mark must agree with the sentence — a row ending in a loss
     cannot say "beat". That is the self-contradiction, stated directly. */
  const contradictory = [];
  [...host.querySelectorAll(".sw-bucket .sw-team")].forEach((row) => {
    const team = row.querySelector(".sw-tname").textContent.trim();
    const marks = [...row.querySelectorAll(".sw-tpips i")].map((i) => i.className.trim()).filter(Boolean);
    const line = row.querySelector(".sw-tline").textContent.replace(/\s+/g, " ").trim();
    if (!marks.length || !/beat|lost to/.test(line)) return;
    const lastMark = marks[marks.length - 1];
    const saysWon = /\bbeat\b/.test(line);
    if ((lastMark === "w") !== saysWon) contradictory.push(`${team}: marks end "${lastMark}" but line says "${line}"`);
  });
  ok(contradictory.length === 0,
     "the last mark on a row agrees with the result printed beside it",
     contradictory.slice(0, 3).join(" | "));

  /* The elimination rows, by contrast, SHOULD show the elimination result —
     that is their whole purpose, and this keeps the fix from being "hide it". */
  const elimLines = [...host.querySelectorAll(".sw-elimteams .sw-team")]
    .map((r) => r.querySelector(".sw-tline").textContent.replace(/\s+/g, " ").trim());
  const elimTeams = decided.flatMap((m) => [m.teamA.name, m.teamB.name]);
  const shown = elimLines.filter((l) => elimTeams.some((t) => l.includes(t))).length;
  ok(shown > 0, "the elimination rows DO report the elimination result", `${shown} of ${elimLines.length}`);
  host.remove();
}
