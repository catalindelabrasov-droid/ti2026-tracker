/* The strip above every tab answers ONE question: is TI on right now?
 *
 * Run: node tools/test_live_strip_ti_only.js        (needs jsdom)
 *
 * WHY THIS EXISTS
 *
 * live-matches returns every pro game on a Valve server, and "pro" is a weak
 * test — isPro() is only "has a league id and two team names", which amateur
 * and pub-tier leagues satisfy all day. The strip rendered that list verbatim.
 *
 * On 20 Aug 2026, minutes after the first playoff quarterfinal ended, the top
 * of the site read:
 *
 *     LIVE  Team Hollow_skies37  0-0  Team Kishi Kaisei  7'
 *
 * with the same LIVE badge the Grand Final will carry. Nothing failed; the
 * feed was accurate and the render was faithful. It was simply answering a
 * different question from the one the strip is for.
 *
 * The games are NOT dropped. The Tournaments tab already renders all of them
 * under "Playing right now" — that is the tab for finding any pro game to
 * watch. This asserts the split holds in both directions, because the easy
 * mistake in either direction is silent: a filter that is too tight hides TI,
 * a filter that is too loose puts a pub game above the bracket.
 */
const fs = require("fs");
const path = require("path");

let JSDOM;
try { ({ JSDOM } = require("jsdom")); }
catch (e) { console.error("CANNOT RUN: jsdom missing.  npm install"); process.exit(1); }

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const script = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/
  .exec(html)[1].replace(/\ninit\(\);?/, "\n");

let fail = 0;
const ok = (c, m, x) => { console.log((c ? "  ok   " : "  FAIL ") + m + (x ? "   " + x : "")); if (!c) fail++; };

function boot() {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='app'></div>"
    + "<div id='liveStripScroll'></div>"
    + "<button class='hubtab' data-hubtab='tournaments'></button></body></html>",
    { url: "https://dota2tileague.com", runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window;
  w.fetch = () => Promise.resolve({ ok: false, json: async () => ({}), text: async () => "" });
  w.scrollTo = () => {};
  w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.console.error = () => {};
  const s = w.document.createElement("script"); s.textContent = script;
  w.document.body.appendChild(s);
  return w;
}

const TI_LEAGUE = 19719;
const game = (id, leagueId, a, b, extra) => Object.assign({
  id: String(id), leagueId, event: leagueId === TI_LEAGUE ? "The International 2026" : "Some Minor League",
  teamA: { name: a, score: 30 }, teamB: { name: b, score: 20 },
  seriesA: 1, seriesB: 0, gameMinute: 33, spectators: 0, status: "live",
}, extra || {});

const TI = game(1, TI_LEAGUE, "Team Spirit", "Iron Wing");
const PUB1 = game(2, 99991, "Team Hollow_skies37", "Team Kishi Kaisei");
const PUB2 = game(3, 99992, "La Tokyo Manji", "Alquimistas");

/* LIVE_FEED is declared `let` at script top level, so it is a lexical binding
   and NOT a property of window - assigning w.LIVE_FEED creates a second,
   unrelated variable and every assertion here passed against an empty feed.
   eval() reaches the real binding. */
function setFeed(w, matches) {
  w.eval("LIVE_FEED = " + JSON.stringify(
    { liveMatches: matches, tiLeagueId: TI_LEAGUE, tournaments: [], events: [] }) + ";");
}

function strip(matches) {
  const w = boot();
  setFeed(w, matches);
  w.renderLiveStrip();
  const el = w.document.getElementById("liveStripScroll");
  return { w, html: el.innerHTML, text: el.textContent.replace(/\s+/g, " ").trim() };
}

console.log("the exact 20 Aug render: a pub game must not reach the strip");
let r = strip([PUB1]);
ok(!/Hollow_skies37/.test(r.html), "Team Hollow_skies37 is not rendered", r.text.slice(0, 70));
ok(/No TI match live right now/.test(r.text),
   "and it says so plainly instead of showing nothing", r.text.slice(0, 70));
ok(/1 other pro game playing/.test(r.text),
   "while telling you the game exists elsewhere", r.text.slice(0, 90));

console.log("\nTI itself must still appear - a filter that hides it is worse");
r = strip([TI]);
ok(/Team Spirit/.test(r.html) && /Iron Wing/.test(r.html),
   "the TI match renders", r.text.slice(0, 70));
ok(!/No TI match/.test(r.text), "and the empty state is gone", "");

console.log("\nmixed feed: TI shown, the rest silently left to Tournaments");
r = strip([PUB1, TI, PUB2]);
ok(/Team Spirit/.test(r.html), "TI is present", "");
ok(!/Hollow_skies37/.test(r.html) && !/Alquimistas/.test(r.html),
   "neither pub game is", r.text.slice(0, 70));

console.log("\nplural, because a count that reads '1 other pro games' looks broken");
r = strip([PUB1, PUB2]);
ok(/2 other pro games playing/.test(r.text), "two -> 'games'", r.text.slice(0, 90));
r = strip([PUB1]);
ok(/1 other pro game playing/.test(r.text) && !/1 other pro games/.test(r.text),
   "one -> 'game'", r.text.slice(0, 90));

console.log("\nnothing live at all keeps the original message");
r = strip([]);
ok(/No pro matches live right now/.test(r.text),
   "no feed at all -> the plain message, no dangling count", r.text.slice(0, 70));

console.log("\nthe jump actually switches tab rather than just looking like a link");
r = strip([PUB1]);
{
  const btn = r.w.document.getElementById("lsToTrn");
  ok(!!btn, "the jump control exists", "");
  let clicked = 0;
  const tab = r.w.document.querySelector('.hubtab[data-hubtab="tournaments"]');
  tab.click = () => { clicked++; };
  if (btn) btn.onclick();
  ok(clicked === 1, "clicking it activates the Tournaments tab", String(clicked));
}

console.log("\nTI is identified by LEAGUE ID, so an outage cannot hide it");
/* isTIMatch falls back to team-name matching when tiLeagueId is null, and null
   is exactly what OpenDota being down produces. live-matches now defaults the
   field to the TI constant for this reason; if that regresses, the strip goes
   blank during precisely the outage the Valve fallback exists to cover. */
{
  const w = boot();
  setFeed(w, [TI]);
  ok(w.isTIMatch(TI) === true, "a TI-league game is TI", "");
  ok(w.isTIMatch(PUB1) === false, "a pub-league game is not", "");
}

console.log("\nand the Tournaments tab still receives every one of them");
/* The other half of the split. If liveProMatches ever starts filtering too,
   the games are not moved - they are gone. */
{
  const w = boot();
  setFeed(w, [PUB1, TI, PUB2]);
  const all = w.liveProMatches();
  ok(all.length === 3, "all three reach the Tournaments tab", String(all.length));
  const names = all.map((m) => (m.teamA || {}).name).join(",");
  ok(/Hollow_skies37/.test(names) && /Team Spirit/.test(names),
     "including both the pub game and TI", names);
}

console.log();
console.log(fail ? fail + " FAILURE(S)" : "all good");
process.exit(fail ? 1 : 0);
