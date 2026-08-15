/* Render the page in Russian and look for lines that came out half-English.
 *
 * Run: node tools/test_mixed_language.js        (needs jsdom)
 *
 * WHY THIS EXISTS, AND WHY test_fragments.js IS NOT ENOUGH
 *
 * test_fragments.js reads the SOURCE. It caught static pairs like
 * `<b>Apply</b> to preview instantly`. It cannot catch the case that actually
 * shipped:
 *
 *     <b>Eliminated</b> · ${note}
 *
 * because the tail contains ${…} and is excluded as code. On /ru/ that rendered
 * "Вылетели · out of the tournament" — a translated head beside an untranslated
 * tail, in one line, in production. A source-level check is structurally blind
 * to anything interpolated, which in this file is most of the page.
 *
 * So this renders the real thing, runs the real localize(), and reads the DOM
 * the way a person would: any element whose own text mixes Cyrillic with a run
 * of English words is a half-translated line.
 */
const fs = require("fs");
const path = require("path");

let JSDOM;
try { ({ JSDOM } = require("jsdom")); }
catch (e) {
  console.error("test_mixed_language CANNOT RUN: jsdom is not installed.  npm install");
  process.exit(1);
}

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data.json"), "utf8"));
const dict = JSON.parse(fs.readFileSync(path.join(ROOT, "ru", "strings.json"), "utf8"));

let fail = 0;
const ok = (c, m, x) => { console.log((c ? "  ok   " : "  FAIL ") + m + (x ? "   " + x : "")); if (!c) fail++; };

const script = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/.exec(html)[1]
  .replace(/\ninit\(\);?/, "\n");

/* Load as /ru/ so LANG resolves to "ru" and the layer arms itself. */
const dom = new JSDOM("<!doctype html><html><body><div id='app'></div></body></html>",
  { url: "https://dota2tileague.com/ru/", runScripts: "dangerously", pretendToBeVisual: true });
const w = dom.window;
/* Serve the real dictionary to the page's own loader. Assigning w.RU_STRINGS
   does NOT work: `let RU_STRINGS` is module-scoped, not a window property, so
   the assignment creates a second unrelated global, localize() sees null and
   returns immediately — and every scan below passes having translated nothing.
   That is exactly the vacuous-pass shape this whole file is meant to catch. */
w.fetch = (u) => Promise.resolve(
  String(u).includes("/ru/strings.json")
    ? { ok: true, json: async () => dict }
    : { ok: false, json: async () => ({}), text: async () => "" });
w.scrollTo = () => {};
w.console.error = () => {};
const el = w.document.createElement("script");
el.textContent = script;
w.document.body.appendChild(el);

(async () => {
await w.loadLang();

/* POSITIVE CONTROL. If the localizer is inert, every "no mix found" below is
   meaningless. Prove it translates before trusting that it found nothing. */
const probe = w.document.createElement("div");
probe.innerHTML = "<h2>Group Stage</h2>";
w.document.body.appendChild(probe);
w.localize(probe);
const translated = probe.querySelector("h2").textContent.trim();
probe.remove();
ok(translated === "Групповой этап",
   "positive control: the localizer is actually running", translated);
if (translated !== "Групповой этап") {
  console.error("\nrefusing to report on scans performed by an inert localizer");
  process.exit(1);
}

/* Things that are English on purpose and must not count as a mix. */
const ALLOWED = /^(Bo\d|TBD|OG|TI|GG|MMR|Dota ?2?|Valve|Liquipedia|OpenDota|Steam|Glicko-2|CC BY-SA|The International|English|Twitch|YouTube|API|JSON|Web|Corporation)$/i;
const teamNames = new Set();
for (const t of data.teams || []) {
  if (t.name) teamNames.add(t.name);
  for (const p of t.players || []) if (p.ign) teamNames.add(p.ign);
}

function scan(label, htmlStr) {
  const d = new JSDOM(`<!doctype html><html><body><div id="x">${htmlStr}</div></body></html>`);
  const root = d.window.document.getElementById("x");
  /* Run the SHIPPED localizer over it. */
  w.document.body.appendChild(w.document.createElement("div")).innerHTML = htmlStr;
  const live = w.document.body.lastChild;
  w.localize(live);

  const bad = [];
  for (const node of live.querySelectorAll("*")) {
    if (node.closest("[data-noloc]")) continue;
    if (["SCRIPT", "STYLE"].includes(node.tagName)) continue;
    /* Look at elements that DIRECTLY hold text, and read their full textContent
       — inline children included.
       Own-text-only was too narrow and missed the case this file exists for:
       `<span><b>Вылетели</b> · out of the tournament</span>` puts the Cyrillic
       in the child and the English in the parent, so neither half looks mixed
       on its own. Requiring a direct text child keeps big containers out. */
    const hasOwnText = [...node.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim());
    if (!hasOwnText) continue;
    const own = (node.textContent || "").replace(/\s+/g, " ").trim();
    if (!own || !/[А-яЁё]/.test(own)) continue;
    /* Strip what is legitimately Latin, then see if English prose remains. */
    let rest = own;
    for (const t of teamNames) rest = rest.split(t).join(" ");
    rest = rest.replace(/[А-яЁё]+/g, " ").replace(/[0-9]+/g, " ");
    const words = (rest.match(/\b[A-Za-z][A-Za-z'’-]{2,}\b/g) || []).filter((x) => !ALLOWED.test(x));
    if (words.length >= 2) bad.push({ text: own.slice(0, 110), words: words.slice(0, 6) });
  }
  live.remove();
  ok(bad.length === 0, `${label}: no half-translated line`,
     bad.length ? `${bad.length} found` : "");
  for (const b of bad.slice(0, 5)) console.log(`         ${JSON.stringify(b.text)}  <- ${b.words.join(" ")}`);
  return bad.length;
}

console.log("");
let total = 0;

/* EVERY render surface, not two.
   The first version scanned renderGroups and renderLive only — and the defect
   that actually shipped ("минимум" spliced into an English sentence) lived in
   renderTeamsTabInto, which was not among them. Two of sixteen surfaces is not
   coverage, it is a sample that happened to miss the bug. */
const SURFACES = [
  ["group stage", () => w.renderGroups(data)],
  ["live & upcoming", () => w.renderLive(data)],
  ["playoffs bracket", () => w.renderBracket(data)],
  ["teams", () => w.renderTeams(data)],
  ["qualifiers", () => w.renderQualifiers(data)],
  ["prize pool", () => w.renderPrize(data, null)],
  ["teams tab", () => w.renderTeamsTabInto && w.renderTeamsTabInto()],
  ["players tab", () => w.renderPlayersTabInto && w.renderPlayersTabInto()],
  ["tournaments", () => w.renderTournaments && w.renderTournaments()],
  ["live strip", () => w.renderLiveStrip && w.renderLiveStrip()],
];
let scanned = 0;
for (const [name, fn] of SURFACES) {
  let markup;
  try { markup = fn(); } catch (e) { console.log(`  --   ${name}: threw (${e.message.slice(0, 50)})`); continue; }
  if (typeof markup !== "string" || !markup.trim()) { console.log(`  --   ${name}: renders nothing here`); continue; }
  total += scan(name, markup);
  scanned++;
}
ok(scanned >= 5, `scanned ${scanned} of ${SURFACES.length} surfaces`,
   scanned < 5 ? "too few rendered to call this coverage" : "");

/* And with the Swiss finished plus the elimination round drawn — the state that
   produced "Вылетели · out of the tournament". */
const c = JSON.parse(JSON.stringify(data));
for (const rd of c.groupStage.rounds || []) {
  for (const m of rd.matches || []) {
    const a = (m.teamA || {}).name, b = (m.teamB || {}).name;
    if (!a || !b || a === "TBD") continue;
    m.teamA = { name: a, score: 2 }; m.teamB = { name: b, score: 0 }; m.status = "completed";
  }
}
total += scan("group stage, Swiss finished", w.renderGroups(c));

console.log(fail ? `\n${fail} SURFACE(S) render half-translated` : "\nno half-translated lines");
process.exit(fail ? 1 : 0);
})();
