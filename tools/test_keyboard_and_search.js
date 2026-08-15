/* Anything that says it is a button must work like one — and a search must not
 * leave labelled, empty boxes behind.
 *
 * Run: node tools/test_keyboard_and_search.js       (needs jsdom)
 *
 * WHY THIS EXISTS
 *
 * 1. wireTeams bound its keydown handler only when `el.tagName === "TR"`. Every
 *    group-stage row — and, once the elimination round shipped, its confirmed
 *    rows too — is a div carrying role="button" and tabindex="0". They took
 *    focus and announced themselves to a screen reader as buttons, and then
 *    Enter and Space did nothing whatsoever. 26 such rows, then 10 more.
 *
 * 2. applySearchFilter hid emptied .sw-elim sections but not .sw-bucket blocks.
 *    Searching "OG" left six of seven record blocks on screen with nothing in
 *    them, each still displaying its team count — so an empty box also asserted
 *    a number that was no longer true.
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

function boot() {
  const shell = html.replace(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/, "<script></script>");
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
  return { w, errs };
}

/* ---------- 1. keyboard ---------------------------------------------- */
console.log("rows that announce themselves as buttons respond to the keyboard");
{
  const { w, errs } = boot();
  const rows = [...w.document.querySelectorAll('[data-team][role="button"]')];
  ok(rows.length > 0, "found rows marked role=button", String(rows.length));

  /* Count real openTeam calls rather than trusting a handler exists. */
  let opened = 0;
  const realOpen = w.openTeam;
  w.openTeam = (...a) => { opened++; return realOpen.apply(w, a); };
  /* Re-wire so the rows pick up the instrumented openTeam. This deliberately
     leaves TWO handlers on each row, so the counts printed below read "2" —
     that is this harness, not double-binding in the product. render() replaces
     #app wholesale, so the real page never accumulates them. */
  w.wireTeams(data);

  const press = (el, key) => {
    const ev = new w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  };

  const row = rows[0];
  const beforeEnter = opened;
  const preventedEnter = press(row, "Enter");
  ok(opened > beforeEnter, "Enter opens the team", `${opened - beforeEnter} call(s)`);
  ok(preventedEnter, "…and Enter's default is prevented");

  const beforeSpace = opened;
  const preventedSpace = press(row, " ");
  ok(opened > beforeSpace, "Space opens the team too", `${opened - beforeSpace} call(s)`);
  ok(preventedSpace, "…and Space's default is prevented, so the page does not scroll");

  /* An unrelated key must do nothing. Without this, a handler that fired on
     everything would pass the two assertions above. */
  const beforeOther = opened;
  press(row, "a");
  ok(opened === beforeOther, "an unrelated key does nothing");

  /* Every such row must be focusable. */
  const noTab = rows.filter((r) => !r.hasAttribute("tabindex"));
  ok(noTab.length === 0, "every role=button row is focusable", `${noTab.length} without tabindex`);

  ok(errs.length === 0, "no console errors", errs.slice(0, 2).join(" | "));
}

/* ---------- 2. search leaves no empty labelled boxes ------------------ */
console.log("\na search does not leave empty boxes with counts on them");
{
  const { w, errs } = boot();
  const visible = (el) => !el.classList.contains("hidden");
  const buckets = () => [...w.document.querySelectorAll(".sw-bucket")];

  ok(buckets().length > 0, "group-stage buckets render", String(buckets().length));
  const all = buckets().filter(visible).length;

  const inp = w.document.querySelector("#searchInput");
  ok(!!inp, "the search box exists");
  const search = (term) => {
    inp.value = term;
    inp.dispatchEvent(new w.Event("input", { bubbles: true }));
  };

  /* A term that matches one team: buckets holding nobody must go. */
  const someTeam = ((w.computeGroupStandings(data).rows || [])[0] || {}).team || "OG";
  search(someTeam);
  const stranded = buckets().filter((b) => {
    const rows = [...b.querySelectorAll(".sw-team")];
    return visible(b) && rows.length > 0 && rows.every((r) => r.classList.contains("hidden"));
  });
  ok(stranded.length === 0,
     `searching "${someTeam}" leaves no bucket visible with all its rows hidden`,
     stranded.map((b) => (b.querySelector(".sw-brec") || {}).textContent).join(", "));

  /* At least one bucket SHOULD still be visible — the one holding the match.
     Without this the fix could pass by hiding everything. */
  ok(buckets().some(visible), "…and the bucket that does match is still shown");

  /* A term matching nothing hides them all. */
  search("zzzz-no-such-team");
  ok(buckets().every((b) => !visible(b)), "a search matching nothing leaves no buckets");

  /* Clearing restores every one. */
  search("");
  ok(buckets().filter(visible).length === all, "clearing the search restores them all",
     `${buckets().filter(visible).length} of ${all}`);
  ok(errs.length === 0, "no console errors", errs.slice(0, 2).join(" | "));
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall good");
process.exit(fail ? 1 : 0);
