/* The page must not tell the reader something the data contradicts.
 *
 * Run: node tools/test_says_what_is_true.js        (needs jsdom)
 *
 * WHY THIS EXISTS
 *
 * Three separate bugs on 15 Aug were the same bug: text that was written once
 * and then outlived the thing it described. None of them threw, none failed a
 * test, and all three were on screen above the fold.
 *
 *   - the live rail said "Check back when the group stage begins on 13 August"
 *     two days after it began, with 39 matches played
 *   - the header said "GROUP STAGE BEGINS" for the whole tournament, because
 *     .live-now hid the countdown DIGITS but not the label; in Russian it ended
 *     on a dangling preposition whose object the CSS had removed
 *   - every completed match was badged "Final", which the dictionary renders as
 *     "Финал" — "this is the Final", not "final score"
 *
 * The invariant is not about wording. It is that a claim about tournament state
 * must be derived from the data, or hidden when it stops being true.
 */
const fs = require("fs");
const path = require("path");

let JSDOM;
try { ({ JSDOM } = require("jsdom")); }
catch (e) { console.error("CANNOT RUN: jsdom missing.  npm install"); process.exit(1); }

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data.json"), "utf8"));
const dict = JSON.parse(fs.readFileSync(path.join(ROOT, "ru", "strings.json"), "utf8"));

let fail = 0;
const ok = (c, m, x) => { console.log((c ? "  ok   " : "  FAIL ") + m + (x ? "   " + x : "")); if (!c) fail++; };

/* ---------- 1. the countdown label dies with its digits ------------------ */
console.log("the countdown does not outlive itself");
{
  /* Both halves must be hidden by the same state class. Hiding only the digits
     is what left "GROUP STAGE BEGINS" stranded. */
  const units = /\.countdown\.live-now\s+\.cd-units\s*\{[^}]*display\s*:\s*none/.test(html);
  const label = /\.countdown\.live-now\s+\.cd-target\s*\{[^}]*display\s*:\s*none/.test(html);
  ok(units, ".live-now hides the countdown digits");
  ok(label, ".live-now also hides the label that introduces them",
     label ? "" : 'without this the header reads "GROUP STAGE BEGINS" forever');
  /* And the banner that replaces them must still appear, or the header is empty. */
  ok(/\.countdown\.live-now\s+\.cd-livebanner\s*\{[^}]*display\s*:\s*flex/.test(html),
     "…and the live banner takes their place");
}

/* ---------- 2. a finished match is not badged "Final" -------------------- */
console.log("\na completed match says finished, not Final");
{
  const badge = /if\(s==="completed"\|\|s==="done"\)return`<span class="badge completed">([^<]+)<\/span>`/.exec(html);
  ok(!!badge, "found the completed badge");
  if (badge) {
    ok(badge[1] !== "Final",
       "the completed badge is not the word Final", `it says "${badge[1]}"`);
    /* Whatever it says must be translatable, or /ru/ shows English. */
    ok(Object.prototype.hasOwnProperty.call(dict, badge[1]),
       `"${badge[1]}" has a Russian translation`, dict[badge[1]] || "MISSING from ru/strings.json");
    /* And it must not collide with the Bo-length label, where Финал is right. */
    ok(dict[badge[1]] !== dict["Final"],
       "…and it does not reuse the key that means the Grand Final",
       `${JSON.stringify(dict[badge[1]])} vs Final=${JSON.stringify(dict["Final"])}`);
  }
}

/* ---------- 3. no calendar date is welded into a claim ------------------- */
console.log("\nno hardcoded date makes a claim about the schedule");
{
  /* Only the functions that describe STATE. Dates inside data.json values are
     fine — those change with the data. */
  const MONTH = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/;
  const targets = ["liveRailInner"];
  for (const fn of targets) {
    const m = new RegExp(`function ${fn}\\(d\\)\\{[\\s\\S]*?\\n\\}`).exec(html);
    ok(!!m, `found ${fn}`);
    if (!m) continue;
    const body = m[0].replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
    const hit = MONTH.exec(body);
    ok(!hit, `${fn} states no month name`, hit ? `"${hit[1]}" will be wrong the day after it passes` : "");
  }
}

/* ---------- 4. render it and check nothing contradicts the data ---------- */
console.log("\nrendered: the page agrees with the tournament");
{
  const shell = html.replace(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/, "<script></script>");
  const script = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/.exec(html)[1].replace(/\ninit\(\);?/, "\n");
  const dom = new JSDOM(shell, { url: "https://dota2tileague.com/", runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window;
  w.fetch = () => Promise.resolve({ ok: false, json: async () => ({}), text: async () => "" });
  w.scrollTo = () => {};
  w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  const errs = [];
  w.console.error = (...a) => { if (!/[Ss]upabase/.test(String(a[0]))) errs.push(String(a[0])); };
  const s = w.document.createElement("script"); s.textContent = script;
  w.document.body.appendChild(s);
  w.render(data);
  w.startCountdown(data);

  const played = (data.groupStage.rounds || []).flatMap((r) => r.matches || [])
    .filter((m) => m.status === "completed").length;
  console.log(`         (${played} group matches completed)`);

  const cd = w.document.querySelector(".countdown");
  const live = cd && cd.classList.contains("live-now");
  ok(!(played > 0) || live, "with matches played, the countdown is in its live state");

  /* The decisive check: if the tournament has started, the page must not
     anywhere claim it is about to. jsdom applies the stylesheet, so a hidden
     element reports display:none. */
  if (played > 0) {
    const visibleText = [...w.document.querySelectorAll(".countdown *")]
      .filter((el) => !el.children.length && w.getComputedStyle(el).display !== "none")
      .map((el) => el.textContent.trim()).join(" ");
    ok(!/begins|starts in|begins in/i.test(visibleText),
       "the header does not say the stage is about to begin", visibleText.slice(0, 70));
  }
  ok(errs.length === 0, "no console errors", errs.slice(0, 2).join(" | "));
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall good");
process.exit(fail ? 1 : 0);
