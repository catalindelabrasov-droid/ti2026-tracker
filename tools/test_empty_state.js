/* The "nothing live" message must never claim a past date is in the future.
 *
 * Run: node tools/test_empty_state.js         (needs jsdom)
 *
 * WHY THIS EXISTS
 *
 * liveRailInner's empty state ended with a hardcoded sentence:
 *
 *     'Check back when the group stage begins on 13 August.'
 *
 * It renders whenever no TI match is live or drawn — every night and between
 * rounds — so from 14 Aug onward the front page told readers to come back for a
 * stage that had already started, with 39 group matches already played. By the
 * main event it would have been three weeks stale. Nothing failed; it was simply
 * wrong, in English, above the fold.
 *
 * A date written into a sentence cannot stay true. The invariant is therefore
 * not "the wording is right" but: the message must MATCH THE ACTUAL STATE of the
 * tournament, and must never name a date that has already passed as if it were
 * still ahead.
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
const script = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/.exec(html)[1].replace(/\ninit\(\);?/, "\n");

let fail = 0;
const ok = (c, m, x) => { console.log((c ? "  ok   " : "  FAIL ") + m + (x ? "   " + x : "")); if (!c) fail++; };

function boot(lang) {
  const dom = new JSDOM("<!doctype html><html><body><div id='app'></div></body></html>",
    { url: "https://dota2tileague.com" + (lang === "ru" ? "/ru/" : "/"),
      runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window;
  w.fetch = (u) => Promise.resolve(String(u).includes("strings.json")
    ? { ok: true, json: async () => dict } : { ok: false, json: async () => ({}), text: async () => "" });
  w.scrollTo = () => {};
  w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  const errs = [];
  w.console.error = (...a) => { if (!/[Ss]upabase/.test(String(a[0]))) errs.push(String(a[0])); };
  const s = w.document.createElement("script"); s.textContent = script;
  w.document.body.appendChild(s);
  return { w, errs };
}

/* Strip every TI fixture of its teams so the rail has nothing to show — the
   state the message exists for. `played` controls whether the tournament looks
   under way. */
function emptied(played) {
  const d = JSON.parse(JSON.stringify(data));
  const strip = (m) => {
    m.teamA = { name: "TBD", score: null };
    m.teamB = { name: "TBD", score: null };
    m.status = played ? "completed" : "upcoming";
  };
  (d.groupStage.rounds || []).forEach((r) => (r.matches || []).forEach(strip));
  (d.groupStage.eliminationMatches || []).forEach(strip);
  const br = (d.bracket || {}).rounds || {};
  [...(br.upper || []), ...(br.lower || [])].forEach((r) => (r.matches || []).forEach(strip));
  (d.qualifiers || []).forEach((q) => (q.matches || []).forEach(strip));
  return d;
}

const textOf = (w, d) => {
  const host = w.document.createElement("div");
  host.innerHTML = w.liveRailInner(d);
  w.document.body.appendChild(host);
  if (w.LANG === "ru") w.localize(host);
  const t = host.textContent.replace(/\s+/g, " ").trim();
  host.remove();
  return t;
};

/* ---------- 1. no hardcoded calendar date in the source ------------------ */
console.log("no date is written into the message");
{
  const fn = /function liveRailInner\(d\)\{[\s\S]*?\n\}/.exec(html);
  ok(!!fn, "found liveRailInner");
  /* Comments are stripped first. The comment above this code deliberately quotes
     the old buggy sentence — including the word "August" — so scanning the raw
     source flags the documentation that explains the fix. The invariant is about
     what the function EMITS, not what it says about itself. */
  const body = (fn ? fn[0] : "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
  const MONTHS = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/;
  const hit = MONTHS.exec(body);
  ok(!hit, "no month name is hardcoded in the emitted message",
     hit ? `found "${hit[1]}" — it will be wrong the day after it passes` : "");
  /* And the guard must still be able to fire: prove the stripper did not eat
     the whole body. */
  ok(/toLocaleDateString/.test(body), "…and the stripper left the real code intact");
}

/* ---------- 2. the message matches reality ------------------------------- */
console.log("\nthe message matches the state of the tournament");
{
  const { w, errs } = boot("en");
  /* Tournament under way (this is today: 39 group matches complete). */
  const under = textOf(w, emptied(true));
  console.log(`         under way -> "${under}"`);
  ok(!/begins on|starts on|Starts /i.test(under),
     "does NOT promise a start date once matches have been played", under);
  ok(/rounds are drawn|schedule/i.test(under),
     "says something true about waiting for the next round instead");

  /* Nothing played yet, and the start is genuinely in the future. */
  const future = emptied(false);
  future.meta.dates.groupStageStart = new Date(Date.now() + 86400000 * 3).toISOString();
  const notYet = textOf(w, future);
  console.log(`         not started -> "${notYet}"`);
  ok(/Starts /i.test(notYet), "DOES give a start date when the start is still ahead", notYet);

  /* Nothing played, but the published start has already passed — the exact
     shape of the original bug. It must not say "starts". */
  const stale = emptied(false);
  stale.meta.dates.groupStageStart = new Date(Date.now() - 86400000 * 2).toISOString();
  const past = textOf(w, stale);
  console.log(`         start passed -> "${past}"`);
  ok(!/Starts |begins on/i.test(past),
     "does NOT announce a start date that has already passed", past);

  ok(errs.length === 0, "no console errors", errs.slice(0, 2).join(" | "));
}

/* ---------- 3. Russian ---------------------------------------------------- */
console.log("\nRussian");
{
  const { w, errs } = boot("ru");
  return (async () => {
    await w.loadLang();
    const under = textOf(w, emptied(true));
    console.log(`         "${under}"`);
    const latin = (under.match(/[A-Za-z]/g) || []).join("");
    /* "TI" is a proper noun and stays. Anything else Latin is untranslated. */
    ok(/[Ѐ-ӿ]/.test(under), "the empty state renders in Russian", under);
    ok(latin.replace(/TI/g, "").length === 0,
       "no English words left in it", latin || "(none)");
    ok(errs.length === 0, "no console errors in Russian", errs.slice(0, 2).join(" | "));

    console.log(fail ? `\n${fail} FAILURE(S)` : "\nall good");
    process.exit(fail ? 1 : 0);
  })();
}
