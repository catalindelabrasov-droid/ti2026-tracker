/* A re-render must not replay the tab fade, and must not leak listeners.
 *
 * Run: node tools/test_no_render_flash.js        (needs jsdom)
 *
 * WHY THIS EXISTS
 *
 * A user reported the page "clips" — a brief blink — on load and now and then
 * while watching. The cause was one CSS rule:
 *
 *     .tabview.on{display:block;animation:fadein .25s ease}
 *     @keyframes fadein{from{opacity:0;transform:translateY(4px)} ...}
 *
 * render() ends with $("#app").replaceWith(root): the whole page is discarded
 * and rebuilt. Every rebuild therefore created a fresh .tabview.on node, and a
 * freshly inserted element replays its animation from opacity:0 — the entire
 * page faded out and back in over 250ms.
 *
 * That happened far more often than anyone intended:
 *   - twice on every load (once with data.json, again when the live feed lands)
 *   - whenever the data changes while you are watching
 *   - every time the tab regains visibility (visibilitychange -> refreshNow)
 *
 * The fade is now on .tabview.on.anim, added only by a real tab switch.
 *
 * Second bug, found while measuring the first: wireHubTabs() is called from
 * render(), and it registered a popstate and a hashchange listener on window
 * every single time without ever removing them. Two leaked listeners per
 * rebuild, each holding a closure over a detached DOM tree.
 *
 * Both are invisible to a test that only checks rendered HTML — the markup is
 * identical either way. These assertions look at the CSS rule, the class the
 * animation depends on, and the listener count.
 *
 * KNOWN EQUIVALENT MUTANT: swapping the order of the .anim and .on toggles in
 * activate() does not fail this test, and should not — the two calls are
 * synchronous with no paint between them, so the browser recalculates style
 * once, after both. Do not "fix" the test to catch it.
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

/* ---------- 1. the CSS rule itself ---------------------------------------- */
console.log("the fade is scoped to a deliberate switch");

const bare = /\.tabview\.on\s*\{[^}]*\}/.exec(html);
ok(bare && !/animation/.test(bare[0]),
   ".tabview.on carries no animation",
   bare ? bare[0].trim() : "rule not found");
ok(/\.tabview\.on\.anim\s*\{[^}]*animation\s*:\s*fadein/.test(html),
   ".tabview.on.anim is what animates");
ok(/@keyframes\s+fadein/.test(html),
   "the fadein keyframes still exist (tab switching keeps its transition)");

/* ---------- 2. the class is applied only on a real switch ------------------ */
console.log("\nmount vs switch");

function boot() {
  const dom = new JSDOM("<!doctype html><html><body><div id='app'></div></body></html>",
    { url: "https://dota2tileague.com/", runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window;
  w.fetch = () => Promise.resolve({ ok: false, json: async () => ({}), text: async () => "" });
  w.scrollTo = () => {};
  w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  const errs = [];
  w.console.error = (...a) => { if (!/Supabase|supabase/.test(String(a[0]))) errs.push(String(a[0])); };
  const s = w.document.createElement("script");
  s.textContent = script;
  w.document.body.appendChild(s);

  /* Count window listeners without patching prototypes on the shared realm. */
  const added = { popstate: 0, hashchange: 0 };
  const real = w.addEventListener.bind(w);
  w.addEventListener = (type, fn, o) => { if (type in added) added[type]++; return real(type, fn, o); };
  return { w, errs, added };
}

const { w, errs, added } = boot();
w.render(data);

const anyAnim = () => [...w.document.querySelectorAll(".tabview")].filter((v) => v.classList.contains("anim"));
ok(anyAnim().length === 0, "after the first render, no view is animating");

w.render(data);                                    // the second render of a page load
ok(anyAnim().length === 0, "after a re-render, still no view is animating");

/* A person clicks a tab. That one should animate. */
const btn = w.document.querySelector('.hubtab[data-hubtab="teams"]');
ok(!!btn, "the tab buttons exist to click");
if (btn) {
  btn.onclick();
  const animating = anyAnim();
  ok(animating.length === 1 && animating[0].id === "view-teams",
     "clicking a tab animates exactly that view",
     animating.map((v) => v.id).join(",") || "none");
}

/* And a re-render while sitting on that tab must not re-fire it. */
w.render(data);
ok(anyAnim().length === 0, "a re-render while on a switched tab does not re-fire the fade");

/* ---------- 3. window listeners are bound once ---------------------------- */
console.log("\nlisteners survive a rebuild without multiplying");

const before = added.popstate + added.hashchange;
w.render(data); w.render(data); w.render(data);
const after = added.popstate + added.hashchange;
ok(after === before,
   "three more rebuilds add no further popstate/hashchange listeners",
   `${before} -> ${after}`);
/* Two separate once-bound handlers now share these events: wireHubTabs switches
   tabs, wireOverlayNav closes an open panel on Back. Both guard themselves, so
   the number is a small constant and — critically — does not grow with renders,
   which is what the assertion above actually checks. */
ok(before <= 4, "a small constant number of popstate/hashchange listeners", String(before));

/* The once-bound listener must still drive the CURRENT nodes, not the detached
   ones its closure was created with — that is the trap this guard could fall
   into, and it would silently break the back button. */
w.location.hash = "#tab=players";
w.dispatchEvent(new w.Event("hashchange"));
const shown = [...w.document.querySelectorAll(".tabview.on")].map((v) => v.id);
ok(shown.length === 1 && shown[0] === "view-players",
   "a hashchange still switches the live DOM after several rebuilds",
   shown.join(",") || "nothing shown");
ok(w.document.getElementById("view-players").isConnected,
   "and the view it switched is the attached one, not a detached copy");

/* ---------- 4. nothing else moved ---------------------------------------- */
console.log("\nno collateral damage");
ok(errs.length === 0, "no console errors across six renders", errs.slice(0, 2).join(" | "));

const tabsNow = [...w.document.querySelectorAll(".hubtab")].length;
ok(tabsNow >= 4, "the hub tabs still render", String(tabsNow));

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall good");
process.exit(fail ? 1 : 0);
