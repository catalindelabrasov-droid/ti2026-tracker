/* Run the REAL localize() from index.html against a real DOM.
 *
 * Everything else so far has been static analysis, which cannot tell you
 * whether the thing actually swaps text — or, more importantly, whether it
 * leaves English alone. This lifts the shipped functions out of index.html
 * verbatim (no re-typing: a hand-copy that drifts from the file would prove
 * nothing) and executes them under jsdom.
 */
const fs = require("fs");
const path = require("path");
/* Exit NON-ZERO when jsdom is missing.
 *
 * This used to print SKIP and exit 0, so a run with no dependencies installed
 * looked exactly like a run where all 28 checks passed. A test that cannot
 * execute is not a passing test, and reporting it as one is worse than not
 * having it — I quoted "26 checks against a real DOM" as evidence while this
 * file was silently skipping. */
let JSDOM;
try { ({ JSDOM } = require("jsdom")); }
catch (e) {
  console.error("test_i18n CANNOT RUN: jsdom is not installed.");
  console.error("  npm install            (jsdom is a devDependency in package.json)");
  console.error("This is a failure, not a skip — nothing was verified.");
  process.exit(1);
}

const REPO = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(REPO, "index.html"), "utf8");
const dict = JSON.parse(fs.readFileSync(path.join(REPO, "ru/strings.json"), "utf8"));

/* Lift the layer verbatim, from the marker comment to the end of watchLang(). */
const start = src.indexOf("const LANG = ");
const end = src.indexOf("async function init(){");
if (start < 0 || end < 0 || end < start) throw new Error("could not locate the i18n layer");
const LAYER = src.slice(start, end);
console.log(`lifted ${LAYER.split("\n").length} lines of the shipped layer\n`);

let fail = 0;
const ok = (c, m) => { console.log((c ? "  ok   " : "  FAIL ") + m); if (!c) fail++; };

function makeEnv(pathname, strings, data) {
  const dom = new JSDOM(
    `<!doctype html><html lang="en"><head>
       <meta name="description" content="English description">
       <link rel="canonical" id="canonLink" href="https://dota2tileague.com/">
     </head><body></body></html>`,
    { url: "https://dota2tileague.com" + pathname }
  );
  const w = dom.window;
  // Minimal globals the layer touches.
  const scope = {
    location: { pathname },
    document: w.document,
    NodeFilter: w.NodeFilter,
    MutationObserver: w.MutationObserver,
    fetch: async () => ({ ok: !!strings, json: async () => strings }),
    DATA: data,
    localStorage: { getItem: () => null, setItem: () => {} },
    navigator: { languages: ["ru-RU", "ru"] },
  };
  const fn = new Function(
    ...Object.keys(scope),
    LAYER + "\n return {loadLang, localize, watchLang, langBanner, langSwitchHTML, ruText, LANG};"
  );
  return { api: fn(...Object.values(scope)), w, doc: w.document };
}

/* Load the REAL data.json rather than inventing a shape.
 *
 * The first version of this fixture wrote players as {name}/{nick}. data.json
 * actually keys them `ign`, so the shipped guard read a field that does not
 * exist and protected 0 of 84 player handles — while this test passed. A
 * fabricated fixture proves the test agrees with itself, not with production.
 * Same mistake as the seriesGamesBtn/fromStratz one. */
const REAL = JSON.parse(fs.readFileSync(path.join(REPO, "data.json"), "utf8"));
const DATA = {
  teams: [
    { name: "Heroes", players: [{ ign: "Live", role: "Carry" }, { ign: "Standings", role: "Mid" }] },
    ...(REAL.teams || []).slice(0, 4),
  ],
};

/* ---------------------------------------------------------------- English */
console.log("ENGLISH  (path /)");
{
  const { api, doc } = makeEnv("/", dict, DATA);
  ok(api.LANG === "en", "LANG resolves to 'en'");

  const before = `<h2>Group Stage</h2><button>Lock prediction</button>
    <input placeholder="Search teams…"><a>Live &amp; Upcoming</a>`;
  doc.body.innerHTML = before;
  const snapshot = doc.body.innerHTML;
  const title = doc.title, desc = doc.querySelector('meta[name=description]').content;
  const canon = doc.getElementById("canonLink").href;
  const lang = doc.documentElement.lang;

  api.loadLang();          // must be a no-op
  api.localize(doc.body);  // must be a no-op
  api.watchLang();         // must not install anything

  ok(doc.body.innerHTML === snapshot, "localize() leaves the English DOM byte-identical");
  ok(doc.title === title, "page title untouched");
  ok(doc.querySelector('meta[name=description]').content === desc, "meta description untouched");
  ok(doc.getElementById("canonLink").href === canon, "canonical untouched");
  ok(doc.documentElement.lang === lang && lang === "en", "html lang stays 'en'");
  ok(api.langSwitchHTML().includes("/ru/") && api.langSwitchHTML().includes("Русский"),
     "footer offers the Russian link");
  ok(api.ruText("Group Stage") === null, "ruText() returns null with no dictionary loaded");
}

/* ---------------------------------------------------------------- Russian */
console.log("\nRUSSIAN  (path /ru/)");
{
  const { api, doc } = makeEnv("/ru/", dict, DATA);
  ok(api.LANG === "ru", "LANG resolves to 'ru'");
  return_check(api, doc);
}

async function return_check(api, doc) {
  await api.loadLang();
  ok(doc.documentElement.lang === "ru", "html lang switched to 'ru'");
  ok(/трекер/i.test(doc.title), "title is Russian: " + JSON.stringify(doc.title));
  ok(/[А-яЁё]/.test(doc.querySelector('meta[name=description]').content), "meta description is Russian");
  ok(doc.getElementById("canonLink").href === "https://dota2tileague.com/ru/", "canonical points at /ru/");

  /* Strings are written exactly as index.html renders them — the emoji is part
     of the button label, and a bare <td> outside a table is dropped by the
     parser, so the row is wrapped properly. */
  doc.body.innerHTML = `
    <h2>Group Stage</h2>
    <button>🔒 Lock prediction</button>
    <input placeholder="Search teams…" aria-label="Search teams…">
    <a>Live &amp; Upcoming</a>
    <span class="team">Heroes</span>
    <span class="team">Team Spirit</span>
    <span class="nick">Live</span>
    <span class="nick">Standings</span>
    <span data-noloc>Playoffs</span>
    <script>var Teams = "Playoffs";</script>
    <table><tbody><tr><td>377</td><td>Points</td></tr></tbody></table>`;
  api.localize(doc.body);

  const txt = (sel) => doc.querySelector(sel).textContent.trim();
  ok(txt("h2") === "Групповой этап", "h2 translated -> " + txt("h2"));
  ok(txt("button") === "🔒 Зафиксировать прогноз", "button translated -> " + txt("button"));
  ok(txt("a") === "Текущие и ближайшие", "entity-bearing label translated -> " + txt("a"));
  ok(doc.querySelector("input").placeholder === "Поиск команд…", "placeholder translated");
  ok(doc.querySelector("input").getAttribute("aria-label") === "Поиск команд…", "aria-label translated");

  const teams = [...doc.querySelectorAll(".team")].map((e) => e.textContent);
  ok(teams[0] === "Heroes", "team named 'Heroes' NOT translated (collides with a label)");
  ok(teams[1] === "Team Spirit", "ordinary team name untouched");

  const nicks = [...doc.querySelectorAll(".nick")].map((e) => e.textContent);
  ok(nicks[0] === "Live", "player named 'Live' NOT translated");
  ok(nicks[1] === "Standings", "player nicked 'Standings' NOT translated");

  /* The check that would have caught the ign bug: a handle taken from the real
     file, not one this test made up. */
  const realIgn = ((REAL.teams || []).flatMap((t) => t.players || [])[0] || {}).ign;
  ok(!!realIgn, "data.json players still expose `ign`", realIgn ? "e.g. " + realIgn : "SHAPE CHANGED");
  if (realIgn) ok(api.ruText(realIgn) === null, "a REAL player handle is protected", realIgn);

  /* And a name from tiFieldNames() — the list standings and fixtures actually
     render, which drifts from DATA.teams (BoomBoys vs "BetBoom Team"). */
  const field = (REAL.teams || []).map((t) => t.name).filter(Boolean);
  const drifted = field.find((n) => /BoomBoys|Iron Wing|BetBoom/i.test(n)) || field[0];
  if (drifted) ok(api.ruText(drifted) === null, "a real team name is protected", drifted);

  ok(txt("[data-noloc]") === "Playoffs", "[data-noloc] respected");
  ok(doc.querySelector("script").textContent.includes('"Playoffs"'), "script contents untouched");
  const cells = [...doc.querySelectorAll("td")].map((e) => e.textContent.trim());
  ok(cells[0] === "377", "numbers untouched");
  ok(cells[1] === "Очки", "table cells are translated");

  // idempotence: a second pass must change nothing (the observer will re-run)
  const after = doc.body.innerHTML;
  api.localize(doc.body);
  ok(doc.body.innerHTML === after, "localize() is idempotent — no translate-the-translation loop");

  // the observer must catch nodes added later, exactly like a re-render does
  api.watchLang();
  const fresh = doc.createElement("div");
  fresh.innerHTML = "<h3>Leaderboard</h3>";
  doc.body.appendChild(fresh);
  await new Promise((r) => setTimeout(r, 30));
  ok(fresh.querySelector("h3").textContent === "Таблица лидеров",
     "MutationObserver localises nodes added after the initial pass");

  console.log(fail ? `\n${fail} CHECK(S) FAILED` : "\nall checks pass");
  process.exit(fail ? 1 : 0);
}
