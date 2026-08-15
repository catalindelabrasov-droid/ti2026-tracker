/* Render /ru/ and list every English string still visible on it.
 *
 * Run: node tools/test_ru_completeness.js          (needs jsdom)
 *      node tools/test_ru_completeness.js --strict (fail on any regression)
 *
 * WHY THIS EXISTS
 *
 * test_fragments.js and test_mixed_language.js only fire when Russian is
 * ALREADY present — one catches a key that is a sentence fragment, the other a
 * translated head beside an English tail. A line that is 100% English, with no
 * Cyrillic anywhere in it, passes both without a murmur. That is most of what
 * is actually left untranslated, so neither test measures the thing a Russian
 * reader would complain about.
 *
 * This renders every surface as /ru/, runs the real localize(), and reports
 * what a Russian speaker would still be reading in English — sorted by how
 * often it appears, so the worst offenders come first.
 *
 * It is a BUDGET, not a pass/fail. The count is written to
 * tools/.ru-baseline.json; --strict fails if it grows. A translation project is
 * never finished, and a test that demands zero would just get disabled.
 */
const fs = require("fs");
const path = require("path");

let JSDOM;
try { ({ JSDOM } = require("jsdom")); }
catch (e) {
  console.error("test_ru_completeness CANNOT RUN: jsdom is not installed.  npm install");
  process.exit(1);
}

const ROOT = path.join(__dirname, "..");
const BASELINE = path.join(__dirname, ".ru-baseline.json");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data.json"), "utf8"));
const dict = JSON.parse(fs.readFileSync(path.join(ROOT, "ru", "strings.json"), "utf8"));
const strict = process.argv.includes("--strict");

const script = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/.exec(html)[1]
  .replace(/\ninit\(\);?/, "\n");

const dom = new JSDOM("<!doctype html><html><body><div id='app'></div></body></html>",
  { url: "https://dota2tileague.com/ru/", runScripts: "dangerously", pretendToBeVisual: true });
const w = dom.window;
w.fetch = (u) => Promise.resolve(
  String(u).includes("/ru/strings.json")
    ? { ok: true, json: async () => dict }
    : { ok: false, json: async () => ({}), text: async () => "" });
w.scrollTo = () => {};
w.console.error = () => {};
/* textContent BEFORE appendChild. Appending an empty <script> and then filling
   it does not execute it, so the page never loads and every function is
   undefined — a failure that looks like "the test is broken" rather than
   "nothing ran", which is the more dangerous version of the same thing. */
const pageScript = w.document.createElement("script");
pageScript.textContent = script;
w.document.body.appendChild(pageScript);

/* Names and terms that are English on purpose. */
const teamNames = new Set();
for (const t of data.teams || []) {
  if (t.name) teamNames.add(t.name);
  for (const p of t.players || []) if (p.ign) teamNames.add(p.ign);
}
/* data.teams[] is NOT the set of names that reach the screen. It carries the
   org spelling — "BetBoom Team", "Iron Wing TI 2026" — while the fixtures, the
   standings and every rendered row say "BoomBoys" and "Iron Wing". That is the
   same alias drift that mis-scored real picks on 14 Aug 2026, and here it made
   the counter treat "● 0–1 vs BoomBoys" as a different English string from
   "● #–# vs «team»", so the total crept up every time one of those two teams
   appeared in a new fixture. Collect from where the names are actually drawn. */
const addName = (n) => { if (n && n !== "TBD") teamNames.add(n); };
for (const r of (data.groupStage || {}).rounds || [])
  for (const mt of r.matches || []) { addName((mt.teamA || {}).name); addName((mt.teamB || {}).name); }
for (const mt of (data.groupStage || {}).eliminationMatches || []) {
  addName((mt.teamA || {}).name); addName((mt.teamB || {}).name);
}
for (const s of (data.groupStage || {}).standings || []) addName(s.team);
{
  const br = (data.bracket || {}).rounds || {};
  for (const side of [br.upper || [], br.lower || []])
    for (const r of side) for (const mt of r.matches || []) {
      addName((mt.teamA || {}).name); addName((mt.teamB || {}).name);
    }
  const gf = (data.bracket || {}).grandFinal;
  if (gf) { addName((gf.teamA || {}).name); addName((gf.teamB || {}).name); }
}
for (const q of data.qualifiers || [])
  for (const mt of q.matches || []) { addName((mt.teamA || {}).name); addName((mt.teamB || {}).name); }
/* Longest first, so "Iron Wing TI 2026" is consumed before "Iron Wing" can
   match its prefix and leave " TI 2026" behind as a stray English fragment. */
const KEEP = new Set(["Bo1", "Bo3", "Bo5", "TBD", "OG", "TI", "GG", "MMR", "Dota", "Dota 2",
  "Valve", "Liquipedia", "OpenDota", "Steam", "Glicko-2", "English", "Twitch", "YouTube",
  "The International", "Corporation", "CC BY-SA", "JSON", "API", "datdota", "BKB", "Email"]);

/* Where a string comes from decides who can fix it. */
const externalStrings = new Set();
(function collectExternal(o) {
  if (!o || typeof o !== "object") return;
  for (const v of Object.values(o)) {
    if (typeof v === "string" && /[A-Za-z]{3}/.test(v)) externalStrings.add(v.trim());
    else collectExternal(v);
  }
})(data);

(async () => {
  await w.loadLang();

  /* POSITIVE CONTROL — without it, "0 English strings" could mean the renderer
     never ran, which is the failure mode this repo produced eight times today. */
  const probe = w.document.createElement("div");
  probe.innerHTML = "<h2>Group Stage</h2>";
  w.document.body.appendChild(probe);
  w.localize(probe);
  const control = probe.querySelector("h2").textContent.trim();
  probe.remove();
  if (control !== "Групповой этап") {
    console.error(`positive control FAILED (got ${JSON.stringify(control)}) — the localizer is inert.`);
    console.error("Refusing to report a count produced by a renderer that did not run.");
    process.exit(1);
  }
  console.log("positive control ok — the localizer is running\n");

  /* Collapse data-derived variation BEFORE counting.
     "beat BoomBoys 2-0" and "lost to OG 1-2" are the same untranslated string
     with different values in it, and data.json changes every 15 minutes — so a
     raw count drifts on its own and the baseline reports a regression nobody
     caused. That went red in CI within an hour. Normalising means the number
     tracks translation work, not the tournament. */
  const teamRe = teamNames.size
    ? new RegExp([...teamNames].sort((a, b) => b.length - a.length)
        .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g")
    : null;
  const canonical = (t) => {
    let c = t;
    if (teamRe) c = c.replace(teamRe, "«team»");
    return c.replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
  };

  const found = new Map();   // canonical text -> {count, surfaces:Set, external:bool}
  const note = (text, surface) => {
    const t = text.replace(/\s+/g, " ").trim();
    if (!t || t.length < 3) return;
    if (/[А-яЁё]/.test(t)) return;                    // has Russian: other tests own it
    if (teamNames.has(t) || KEEP.has(t)) return;
    if (!/[A-Za-z]{3,}/.test(t)) return;              // numbers, scores, punctuation
    if (/^[\d\s:.,%+·–—-]+$/.test(t)) return;
    const key = canonical(t);
    if (!key || !/[A-Za-z]{3,}/.test(key)) return;
    const e = found.get(key) || { count: 0, surfaces: new Set(), external: externalStrings.has(t), sample: t };
    e.count++; e.surfaces.add(surface);
    found.set(key, e);
  };

  const surfaces = {
    "group stage": () => w.renderGroups(data),
    "live & upcoming": () => w.renderLive(data),
    "playoffs": () => w.renderBracket(data),
    "teams": () => w.renderTeams(data),
    "qualifiers": () => w.renderQualifiers(data),
    "prize pool": () => w.renderPrize(data, null),
  };

  for (const [name, fn] of Object.entries(surfaces)) {
    let markup = "";
    try { markup = fn() || ""; } catch (e) { console.log(`  (${name} threw: ${e.message})`); continue; }
    const host = w.document.createElement("div");
    host.innerHTML = markup;
    w.document.body.appendChild(host);
    w.localize(host);
    for (const el of host.querySelectorAll("*")) {
      if (el.closest("[data-noloc]")) continue;
      if (["SCRIPT", "STYLE"].includes(el.tagName)) continue;
      for (const n of el.childNodes) if (n.nodeType === 3) note(n.nodeValue, name);
      for (const a of ["placeholder", "title", "aria-label"]) {
        const v = el.getAttribute && el.getAttribute(a);
        if (v) note(v, name + " @" + a);
      }
    }
    host.remove();
  }

  const rows = [...found.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));
  const ours = rows.filter(([, v]) => !v.external);
  const ext = rows.filter(([, v]) => v.external);

  console.log(`${rows.length} distinct English strings still visible on /ru/`);
  console.log(`  ${ours.length} ours (fixable in ru/strings.json or by restructuring)`);
  console.log(`  ${ext.length} from data.json / Liquipedia (need a mapping table)\n`);

  const show = (list, title, n) => {
    if (!list.length) return;
    console.log(title);
    for (const [t, v] of list.slice(0, n)) {
      console.log(`  x${String(v.count).padStart(2)}  ${JSON.stringify(t.slice(0, 92))}`);
      console.log(`        ${[...v.surfaces].join(", ")}`);
    }
    if (list.length > n) console.log(`  … and ${list.length - n} more`);
    console.log("");
  };
  show(ours, "OURS — add to ru/strings.json, or restructure if interpolated:", 25);
  show(ext, "EXTERNAL — from data.json, a dictionary entry will not reach these:", 12);

  /* Compare the SET of outstanding strings, not how many there are.
   *
   * A count is the wrong thing to guard here, and it produced four red builds
   * on 15 Aug alone without a single new untranslated string being introduced.
   * The page renders live tournament data, so the strings on it change shape as
   * the event moves: "Round 5 · 0 of 7 series decided" only exists once round 5
   * starts; "● #–# vs «team»" appears the moment a group match goes live. Each
   * of those bumped the count and failed the build for a defect nobody had
   * committed. Meanwhile the count could have stayed flat while one string was
   * translated and a genuinely new one appeared — a real regression, invisible.
   *
   * So the guard is: a string that is not in the known list is a regression.
   * Anything already known can appear more often, less often, or not at all
   * without failing. That is sensitive to exactly what we care about — a NEW
   * English string reaching a Russian reader — and immune to data churn. */
  let base = null;
  try { base = JSON.parse(fs.readFileSync(BASELINE, "utf8")); } catch (e) {}
  const oursSet = ours.map(([t]) => t).sort();

  /* Preserve every key the file already carries. It documents WHY each string
     is still outstanding and how to fix it; rewriting the file with just the
     numbers threw that away every time the count improved. */
  const write = (extra) => fs.writeFileSync(BASELINE,
    JSON.stringify({ ...(base || {}), ...extra, ours: ours.length, total: rows.length,
                     known: oursSet }, null, 2) + "\n");

  if (!base) {
    write({});
    console.log(`baseline written: ${ours.length} ours / ${rows.length} total`);
    process.exit(0);
  }

  console.log(`baseline ${base.ours} ours / ${base.total} total  ->  now ${ours.length} / ${rows.length}`);

  /* First run after this change has no `known` list yet — adopt the current set
     rather than failing on all of it, and say so out loud. */
  if (!Array.isArray(base.known)) {
    write({});
    console.log(`adopted ${oursSet.length} known string(s) — from here, only a NEW one fails`);
    process.exit(0);
  }

  const knownSet = new Set(base.known);
  const fresh = oursSet.filter((t) => !knownSet.has(t));
  const gone = base.known.filter((t) => !oursSet.includes(t));

  if (gone.length) console.log(`  ${gone.length} known string(s) no longer appear (translated, or the data moved on)`);
  if (!fresh.length) {
    /* Only shrink the list — never silently absorb a new string. */
    if (gone.length) { write({}); console.log("  known list narrowed"); }
    console.log("no new English strings on /ru/");
    process.exit(0);
  }

  console.log(`\nREGRESSION: ${fresh.length} English string(s) on /ru/ that were not there before:`);
  fresh.forEach((t) => console.log(`  ${JSON.stringify(t.slice(0, 92))}`));
  console.log("If these are expected, add them to `known` in tools/.ru-baseline.json with a reason.");
  if (strict) process.exit(1);
  process.exit(0);
})();
