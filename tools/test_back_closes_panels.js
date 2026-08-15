/* The browser Back button must close an open panel — and must never leave the
 * tracker hidden behind one.
 *
 * Run: node tools/test_back_closes_panels.js       (needs jsdom)
 *
 * WHY THIS EXISTS
 *
 * The only popstate/hashchange listeners on the page switched hub tabs. Nothing
 * anywhere called closeRegionPage from history. So with "Page" view selected:
 *
 *     open a region -> press Back -> the hash clears, the panel stays open
 *
 * and because `body.region-open #app{display:none}` hides the tracker behind the
 * panel, the site looked blank with no way back except a reload. In the Android
 * wrapper, where Back IS the navigation, that is the entire app dead.
 *
 * Team panels failed differently: openTeam pushed no history entry at all, so
 * Back consumed the hub-tab entry instead — the panel stayed open AND the tab
 * silently changed underneath it.
 *
 * The invariant, in both view modes: after Back, nothing is covering the app.
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

/* The real markup, so body.region-open/#app really exist and the CSS classes
   mean what they mean. */
function boot(viewMode) {
  const shell = html.replace(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/, "<script></script>");
  const dom = new JSDOM(shell, { url: "https://dota2tileague.com/", runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window;
  w.fetch = () => Promise.resolve({ ok: false, json: async () => ({}), text: async () => "" });
  w.scrollTo = () => {};
  w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  const errs = [];
  w.console.error = (...a) => { if (!/[Ss]upabase/.test(String(a[0]))) errs.push(String(a[0])); };
  const s = w.document.createElement("script");
  s.textContent = script;
  w.document.body.appendChild(s);
  /* AFTER the script, not before: a write made before jsdom has finished setting
     the window up reads back as null, which silently left every "page view" case
     running in modal mode — the assertions then passed against a panel that had
     never opened. */
  w.localStorage.setItem("ti2026_region_view", viewMode);
  ok(w.localStorage.getItem("ti2026_region_view") === viewMode,
     `view mode is really "${viewMode}"`, w.localStorage.getItem("ti2026_region_view"));
  w.render(data);
  return { w, errs };
}

/* jsdom does not implement history traversal, so drive the same events the
   browser fires on Back: the hash goes back, then popstate + hashchange. */
const pressBack = (w, toHash) => {
  w.location.hash = toHash || "";
  w.dispatchEvent(new w.Event("popstate"));
  w.dispatchEvent(new w.Event("hashchange"));
};

const covering = (w) =>
  w.document.body.classList.contains("region-open") ||
  w.document.body.classList.contains("team-open") ||
  [...w.document.querySelectorAll(".modal.show, #regionModal.show, #teamModal.show")].length > 0;

/* ---------- Page view: the mode that hid the tracker -------------------- */
console.log('Page view — a panel must not survive Back');
{
  const { w, errs } = boot("page");
  const regionName = ((data.qualifiers || [])[0] || {}).region || "Europe";

  w.openRegion(data, regionName);
  ok(w.document.body.classList.contains("region-open"), `region panel opens (${regionName})`);
  ok(w.location.hash.startsWith("#region="), "…and gives itself a history entry", w.location.hash);

  pressBack(w, "");
  ok(!w.document.body.classList.contains("region-open"),
     "Back closes the region panel");
  ok(!covering(w), ">>> the tracker is visible again after Back");

  const teamName = ((data.teams || [])[0] || {}).name || "Team Spirit";
  w.openTeam(data, teamName);
  ok(w.document.body.classList.contains("team-open"), `team panel opens (${teamName})`);
  ok(w.location.hash.startsWith("#team="),
     "…and now pushes a history entry of its own", w.location.hash || "(none — Back would eat the tab entry)");

  pressBack(w, "");
  ok(!w.document.body.classList.contains("team-open"), "Back closes the team panel");
  ok(!covering(w), ">>> the tracker is visible again after Back");
  ok(errs.length === 0, "no console errors", errs.slice(0, 2).join(" | "));
}

/* ---------- Popup view: the DEFAULT mode -------------------------------- */
console.log("\nPopup view — the default, so most readers are here");
{
  const { w, errs } = boot("modal");
  const regionName = ((data.qualifiers || [])[0] || {}).region || "Europe";
  w.openRegion(data, regionName);
  ok(w.document.querySelector("#regionModal").classList.contains("show"), "region popup opens");
  pressBack(w, "");
  ok(!w.document.querySelector("#regionModal").classList.contains("show"), "Back closes the region popup");

  const teamName = ((data.teams || [])[0] || {}).name || "Team Spirit";
  w.openTeam(data, teamName);
  ok(w.document.querySelector("#teamModal").classList.contains("show"), "team popup opens");
  pressBack(w, "");
  ok(!w.document.querySelector("#teamModal").classList.contains("show"), "Back closes the team popup");
  ok(!covering(w), ">>> nothing is covering the app");
  ok(errs.length === 0, "no console errors", errs.slice(0, 2).join(" | "));
}

/* ---------- the listener must not stack --------------------------------- */
console.log("\nthe handler survives re-renders without multiplying");
{
  const { w } = boot("page");
  let added = 0;
  const real = w.addEventListener.bind(w);
  w.addEventListener = (t, f, o) => { if (t === "popstate" || t === "hashchange") added++; return real(t, f, o); };
  const before = added;
  w.render(data); w.render(data); w.render(data);
  ok(added - before <= 6,
     "three re-renders do not stack overlay listeners", `${added - before} added`);

  /* And it still works after those re-renders — a stale closure would leave the
     panel open while reporting success. */
  const regionName = ((data.qualifiers || [])[0] || {}).region || "Europe";
  w.openRegion(data, regionName);
  pressBack(w, "");
  ok(!w.document.body.classList.contains("region-open"),
     "…and Back still closes the panel after them");
}

/* ---------- the in-panel Back button clears its hash too ---------------- */
console.log("\nthe in-panel back button leaves no stale hash");
{
  const { w } = boot("page");
  w.openTeam(data, ((data.teams || [])[0] || {}).name || "Team Spirit");
  w.closeTeamPage();
  ok(!w.document.body.classList.contains("team-open"), "closeTeamPage closes the panel");
  ok(!w.location.hash.startsWith("#team="), "…and clears the #team= hash", w.location.hash || "(clear)");
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall good");
process.exit(fail ? 1 : 0);
