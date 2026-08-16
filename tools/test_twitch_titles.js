/* The stream-title parser must behave the same on Twitch's API as it did on the
 * scraped page.
 *
 * Run: node tools/test_twitch_titles.js
 *
 * WHY THIS EXISTS
 *
 * match-live used to read team names out of the twitch.tv page's
 * <meta name="description">. It now reads Twitch's own `title` field. Those are
 * NOT the same string: the meta description is the title plus Twitch's own
 * suffix ("| Streaming dota 2 for 6..."). The regex was written against the
 * longer one, so switching the input is exactly where a silent regression would
 * live - streams would still be listed, they would just stop matching to any
 * fixture, and the page would quietly show no "Watch" links.
 *
 * Every string below was captured from production on 2026-08-16: the meta
 * descriptions from the old scraper's own output, the titles from a real Helix
 * call.
 *
 * MUTATION CHECK (verified by hand, each turns this file red)
 *   - drop the [XX] language-tag prefix from the regex -> pairs mis-parse
 *   - make the trailing [-|] terminator optional        -> team B swallows the rest
 *   - anchor the regex with ^                           -> UA co-stream stops matching
 */
const fs = require("fs");
const path = require("path");

let fail = 0;
const ok = (cond, msg, extra) => {
  console.log((cond ? "  ok   " : "  FAIL ") + msg + (extra ? "   " + extra : ""));
  if (!cond) fail++;
};

/* Pull the live regex out of the edge function rather than copying it here, so
   this test tracks the shipped code instead of a stale duplicate. */
const src = fs.readFileSync(
  path.join(path.dirname(__dirname), "supabase", "functions", "match-live", "index.ts"), "utf8");
const m = src.match(/title\.match\((\/.+?\/i)\);/);
if (!m) { console.error("CANNOT RUN: could not find the title regex in match-live/index.ts"); process.exit(1); }
const RE = eval(m[1]);
console.log("regex under test: " + RE);

const parse = (s) => {
  const t = String(s).replace(/\s+/g, " ").trim();
  const x = t.match(RE);
  return x ? { a: x[1].trim(), b: x[2].trim() } : null;
};

/* Real pairs: [what the OLD scraper fed in, what the API feeds in now] */
const PAIRS = [
  [
    "[EN-A] Team Spirit vs. Team Resilience - The International 2026 - Group Stage - Elimination Round | Streaming dota 2 for 6",
    "[EN-A] Team Spirit vs. Team Resilience - The International 2026 - Group Stage - Elimination Round",
    { a: "Team Spirit", b: "Team Resilience" },
  ],
  [
    "[EN-B] Iron Wing vs. GamerLegion - The International 2026 - Group Stage - Elimination Round | Streaming dota 2 for 6",
    "[EN-B] Iron Wing vs. GamerLegion - The International 2026 - Group Stage - Elimination Round",
    { a: "Iron Wing", b: "GamerLegion" },
  ],
  [
    "[RU-A] Team Spirit vs. Team Resilience - The International 2026 - Групповой Этап - Раунд на выбывание | Streaming do",
    "[RU-A] Team Spirit vs. Team Resilience - The International 2026 - Групповой Этап - Раунд на выбывание",
    { a: "Team Spirit", b: "Team Resilience" },
  ],
  [
    "[ES-B] Iron Wing vs. GamerLegion - The International 2026 - Fase de Grupos - Ronda de eliminación | Streaming ",
    "[ES-B] Iron Wing vs. GamerLegion - The International 2026 - Fase de Grupos - Ronda de eliminación",
    { a: "Iron Wing", b: "GamerLegion" },
  ],
  [
    /* PRE-EXISTING QUIRK, deliberately asserted as-is. The terminator [-|] hits
       the hyphen inside the score "(1-0)", so team B truncates to
       "Team Resilience (1". tkey() then normalises that to "resilience(1"
       against the fixture's "resilience", so this co-stream does NOT match its
       match and shows no Watch link.
       It is NOT introduced here - the old scraped description parsed to exactly
       the same truncated string, which is the whole point of this row. Fixing
       the regex is a behaviour change and belongs in its own commit, not in a
       swap of where the text comes from. */
    "[UA] spirit vs Team Resilience (1-0) BO3 | The International 2026: Elimination Round | by @doubleespresso",
    "[UA] spirit vs Team Resilience (1-0) BO3 | The International 2026: Elimination Round | by @doubleespresso",
    { a: "spirit", b: "Team Resilience (1" },
  ],
];

console.log("\nthe API title parses the same as the scraped description did");
PAIRS.forEach(([oldIn, newIn, want]) => {
  const o = parse(oldIn), n = parse(newIn);
  ok(o && n && o.a === n.a && o.b === n.b,
     `same teams from both inputs: ${want.a} vs ${want.b}`,
     `old=${JSON.stringify(o)} new=${JSON.stringify(n)}`);
  ok(n && n.a === want.a && n.b === want.b,
     `and they are the expected names`, JSON.stringify(n));
});

console.log("\nthe language tag does not have to be at the very start");
/* Casters routinely prefix an emoji or a "LIVE" flag. Anchoring the regex with
   ^ would silently drop every such channel, and no other row here would notice
   because they all happen to start with the tag - found by mutation testing on
   2026-08-16, not by reading the code. */
[
  ["\u{1F534} LIVE [EN-A] Team Spirit vs. Team Resilience - The International 2026", "Team Spirit", "Team Resilience"],
  ["TI2026 | [RU-B] Iron Wing vs. GamerLegion - Elimination Round", "Iron Wing", "GamerLegion"],
].forEach(([t, wa, wb]) => {
  const p = parse(t);
  ok(p && p.a === wa && p.b === wb,
     "parses with text before the tag: " + wa + " vs " + wb, JSON.stringify(p));
});

console.log("\ntitles that are NOT a match must not produce a fixture");
[
  "REPRISE - VOLTAREMOS A QUALQUER MOMENTO - The International 2026 - Fase de Grupos dia 4",
  "ROAD to top 100 eu ladder no jokes only tryhard !тимспиритжди !tg",
  "rank 220 going for top 100! pubs aaaaall day !youtube !ig",
  "",
].forEach((t) => ok(parse(t) === null, "no false pair from: " + JSON.stringify(t.slice(0, 46)), ""));

console.log("\nthe rerun case that mislabelled channels on 16 Aug");
const reprise = {
  title: "REPRISE - VOLTAREMOS A QUALQUER MOMENTO - The International 2026 - Fase de Grupos dia 4",
  started_at: new Date(Date.now() - 765 * 60000).toISOString(),
};
ok(parse(reprise.title) === null,
   "a 12-hour rebroadcast yields no team pair, so it cannot be shown as a live fixture", "");
ok(Math.round((Date.now() - Date.parse(reprise.started_at)) / 60000) > 600,
   "and startedAt is now available to label it honestly (not yet wired in)", "");

console.log();
console.log(fail ? fail + " FAILURE(S)" : "all good");
process.exit(fail ? 1 : 0);
