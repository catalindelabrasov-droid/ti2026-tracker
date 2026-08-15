/* The phone prefix must default to the reader's own country.
 *
 * Run: node tools/test_phone_prefix.js          (needs jsdom)
 *
 * WHY THIS EXISTS
 *
 * netlify.toml routes RU, BY, KZ, KG, TJ, UZ, TM, AM, AZ and MD to /ru/. Only
 * RU had a phone prefix. So a reader in Minsk or Almaty was sent to the Russian
 * version by our own geo rule and then could not enter their own number — the
 * country was not in the list at all. And every visitor, everywhere, got "+40"
 * preselected because populatePrefixes() ended with a hardcoded sel.value="+40".
 *
 * Two traps this guards:
 *   - +7 is BOTH Russia and Kazakhstan; +1 is BOTH the US and Canada. Selecting
 *     by VALUE lands on whichever appears first in the list, so the option
 *     carries data-cc and selection goes through that.
 *   - The detector must never pick a country that has no option, or the field
 *     silently falls back and nobody notices.
 */
const fs = require("fs");
const path = require("path");

let JSDOM;
try { ({ JSDOM } = require("jsdom")); }
catch (e) { console.error("CANNOT RUN: jsdom missing.  npm install"); process.exit(1); }

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const script = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/.exec(html)[1].replace(/\ninit\(\);?/, "\n");

let fail = 0;
const ok = (c, m, x) => { console.log((c ? "  ok   " : "  FAIL ") + m + (x ? "   " + x : "")); if (!c) fail++; };

/* Boot with a chosen time zone and locale, then run the real populatePrefixes
   against the real <select> from the shipped markup. */
function boot(tz, langs) {
  const shell = /<select id="su_prefix"[^>]*><\/select>/.test(html)
    ? "<!doctype html><html><body><select id='su_prefix'></select></body></html>"
    : null;
  if (!shell) throw new Error("the #su_prefix select is no longer in index.html");
  const dom = new JSDOM(shell, { url: "https://dota2tileague.com/", runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window;
  w.fetch = () => Promise.resolve({ ok: false, json: async () => ({}), text: async () => "" });
  w.scrollTo = () => {}; w.console.error = () => {};
  w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  /* Pin the zone the page will read. */
  const RealDTF = w.Intl.DateTimeFormat;
  w.Intl.DateTimeFormat = function (...a) {
    const inst = new RealDTF(...a);
    const real = inst.resolvedOptions.bind(inst);
    inst.resolvedOptions = () => ({ ...real(), timeZone: tz });
    return inst;
  };
  Object.defineProperty(w.navigator, "languages", { value: langs || [], configurable: true });
  Object.defineProperty(w.navigator, "language", { value: (langs || [])[0] || "", configurable: true });
  const s = w.document.createElement("script");
  s.textContent = script;
  w.document.body.appendChild(s);
  return w;
}

const selected = (w) => {
  w.populatePrefixes();
  const sel = w.document.getElementById("su_prefix");
  const o = sel.selectedOptions[0];
  return { cc: o && o.getAttribute("data-cc"), value: sel.value, count: sel.options.length };
};

/* ---------- 1. the nine that were missing exist at all ------------------- */
console.log("every geo-routed country has a prefix");
{
  const w = boot("Europe/Bucharest", ["ro-RO"]);
  w.populatePrefixes();
  const sel = w.document.getElementById("su_prefix");
  const have = [...sel.options].map((o) => o.getAttribute("data-cc"));
  /* Exactly the list netlify.toml routes to /ru/. If that list changes, this
     should be updated with it — that is the point. */
  for (const cc of ["RU", "BY", "KZ", "KG", "TJ", "UZ", "TM", "AM", "AZ", "MD"]) {
    ok(have.includes(cc), `${cc} is selectable`, have.includes(cc) ? "" : "MISSING — cannot enter a local number");
  }
  ok(new Set(have).size === have.length, "no duplicate country in the list");
}

/* ---------- 2. detection picks the right one ---------------------------- */
console.log("\nthe default follows the reader");
const CASES = [
  ["Europe/Minsk",       ["ru-BY"], "BY", "+375"],
  ["Asia/Almaty",        ["ru-KZ"], "KZ", "+7"],
  ["Europe/Moscow",      ["ru-RU"], "RU", "+7"],
  ["Europe/Chisinau",    ["ro-MD"], "MD", "+373"],
  ["Asia/Yerevan",       ["hy-AM"], "AM", "+374"],
  ["Asia/Baku",          ["az-AZ"], "AZ", "+994"],
  ["Asia/Tashkent",      ["uz-UZ"], "UZ", "+998"],
  ["Asia/Bishkek",       ["ky-KG"], "KG", "+996"],
  ["Asia/Dushanbe",      ["tg-TJ"], "TJ", "+992"],
  ["Asia/Ashgabat",      ["tk-TM"], "TM", "+993"],
  ["Europe/Bucharest",   ["ro-RO"], "RO", "+40"],
  ["Europe/Kyiv",        ["uk-UA"], "UA", "+380"],
  ["America/Toronto",    ["en-CA"], "CA", "+1"],
  ["America/New_York",   ["en-US"], "US", "+1"],
  ["Asia/Novosibirsk",   ["ru-RU"], "RU", "+7"],
  ["America/Argentina/Cordoba", ["es-AR"], "AR", "+54"],
];
for (const [tz, langs, cc, pre] of CASES) {
  const r = selected(boot(tz, langs));
  ok(r.cc === cc && r.value === pre, `${tz.padEnd(28)} -> ${cc} ${pre}`, `got ${r.cc} ${r.value}`);
}

/* ---------- 2b. the time-zone map ALONE --------------------------------- */
/* The cases above give a matching locale as well, so either signal could be
   carrying them — deleting a whole country from the zone map still passed,
   because "ru-KZ" rescued it. That redundancy is the design, but it hides
   which half works. These pin the zone map on its own: the locale is a bare
   language with no region, so it cannot contribute a country. */
console.log("\nthe time zone alone is enough (locale carries no region)");
for (const [tz, cc] of [
  ["Asia/Almaty", "KZ"], ["Europe/Minsk", "BY"], ["Asia/Tashkent", "UZ"],
  ["Asia/Bishkek", "KG"], ["Asia/Dushanbe", "TJ"], ["Asia/Ashgabat", "TM"],
  ["Asia/Yerevan", "AM"], ["Asia/Baku", "AZ"], ["Europe/Chisinau", "MD"],
  ["Europe/Moscow", "RU"], ["America/Toronto", "CA"],
]) {
  const r = selected(boot(tz, ["ru"]));   // bare language: no region to fall back on
  ok(r.cc === cc, `${tz.padEnd(18)} alone -> ${cc}`, `got ${r.cc}`);
}

/* And the mirror: the locale alone, when the zone is unknown. */
console.log("\nthe locale alone is enough (zone unknown)");
for (const [lang, cc] of [["ru-KZ", "KZ"], ["be-BY", "BY"], ["ro-MD", "MD"], ["en-GB", "GB"]]) {
  const r = selected(boot("Antarctica/Troll", [lang]));
  ok(r.cc === cc, `${lang.padEnd(8)} alone -> ${cc}`, `got ${r.cc}`);
}

/* ---------- 3. the shared-code traps ------------------------------------ */
console.log("\nshared dialling codes resolve to the right country");
{
  /* +7 is Russia AND Kazakhstan; +1 is the US AND Canada. Selecting by value
     would land on whichever is listed first — RU and US respectively. */
  ok(selected(boot("Asia/Almaty", ["ru-KZ"])).cc === "KZ", "Almaty picks KZ, not RU (both are +7)");
  ok(selected(boot("America/Toronto", ["en-CA"])).cc === "CA", "Toronto picks CA, not US (both are +1)");
}

/* ---------- 4. fallbacks ------------------------------------------------ */
console.log("\nfalling back");
{
  ok(selected(boot("Antarctica/Troll", [])).value === "+40",
     "an unknown zone with no locale falls back to +40");
  /* Locale rescues an unlisted zone. */
  const r = selected(boot("Antarctica/Troll", ["ru-KZ"]));
  ok(r.cc === "KZ", "an unknown zone still resolves via the locale region", `got ${r.cc}`);
  /* A bare language says nothing about location and must NOT be guessed at. */
  ok(selected(boot("Antarctica/Troll", ["ru"])).value === "+40",
     'a bare "ru" with no region does not guess a country');
  /* Never select a country that has no option. */
  const w = boot("Africa/Nairobi", ["sw-KE"]);
  const r2 = selected(w);
  ok(r2.cc !== null && r2.cc !== undefined, "an unsupported country still leaves a valid selection", String(r2.cc));
  ok(r2.value === "+40", "...and that selection is the +40 fallback", r2.value);
}

/* ---------- 5. the value the form actually submits ---------------------- */
console.log("\nthe field still yields a usable value");
{
  const w = boot("Europe/Minsk", ["ru-BY"]);
  w.populatePrefixes();
  const v = w.document.getElementById("su_prefix").value;
  ok(/^\+\d{1,4}$/.test(v), "the selected value is a dialling code", v);
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall good");
process.exit(fail ? 1 : 0);
