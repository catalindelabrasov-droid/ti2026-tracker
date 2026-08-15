/* User-supplied names must be shielded from the dictionary.
 *
 * Run: node tools/test_noloc_guards.js       (no dependencies)
 *
 * WHY THIS EXISTS
 *
 * protectedText() is built from DATA.teams, so it covers TI teams and players.
 * It does NOT cover anything from Supabase — league names, member usernames,
 * leaderboard nicknames. Those have exactly one defence: data-noloc at the
 * render site. Removing it from any of the four sites was invisible to every
 * other test in this repo.
 *
 * That matters more than it sounds. A large share of the dictionary keys are
 * strings a person could plausibly choose as a username — Admin, Live, Points,
 * Heroes, World, Pro, Final, You, Now, Player, Team. A league member called
 * "Admin" would be rendered as "Админ" on /ru/, in a leaderboard, next to their
 * real score.
 *
 * So this pins the guards in place and reports how much is riding on them.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const dict = JSON.parse(fs.readFileSync(path.join(ROOT, "ru", "strings.json"), "utf8"));
const keys = Object.keys(dict).filter((k) => k.charAt(0) !== "_");

let fail = 0;
const ok = (c, m, x) => { console.log((c ? "  ok   " : "  FAIL ") + m + (x ? "   " + x : "")); if (!c) fail++; };

/* Every place a name that came from Supabase reaches the DOM. Each entry is a
   snippet that must appear WITH data-noloc on it. Keep this list in step with
   renderLeague / lgLeaderboard / the tournament and ladder tables. */
/* Assert the GUARDED form verbatim, not "is data-noloc somewhere nearby".
   A proximity window found the first textual occurrence of esc(m.username) —
   which is a data-name="…" attribute on a button, not the visible render — and
   reported three false failures against code that was correct. The attribute is
   not a text node and localize() never touches it. */
const SITES = [
  { what: "league member username", guarded: "data-noloc>${esc(m.username)}" },
  { what: "league name (heading)", guarded: "data-noloc>${esc(lg.name)}" },
  { what: "prediction leaderboard name", guarded: "data-noloc>${esc(p.name)}" },
  { what: "tournament/ladder team name", guarded: "data-noloc>${esc(x.name)}" },
  { what: "tournament standings name", guarded: "data-noloc>${esc(r.name)}" },
];

for (const s of SITES) {
  ok(src.includes(s.guarded), `${s.what} is shielded by data-noloc`,
     src.includes(s.guarded) ? "" : `expected ${s.guarded}`);
}

/* How much is riding on those guards. */
const looksLikeUsername = (k) =>
  /^[A-Za-z][A-Za-z0-9 '’-]{1,23}$/.test(k) && !/[.!?·—]/.test(k) && k.split(/\s+/).length <= 2;
const collisions = keys.filter(looksLikeUsername);
console.log(`\n  ${collisions.length} of ${keys.length} dictionary keys are plausible usernames.`);
console.log(`  Each one is a person whose name would be translated if a guard is dropped.`);
console.log(`  e.g. ${collisions.slice(0, 12).join(", ")}`);

/* protectedText must read the field the data actually uses. */
const pt = src.slice(src.indexOf("function protectedText"), src.indexOf("function ruText"));
ok(/p\.ign/.test(pt), "protectedText reads p.ign (the field data.json actually uses)");
ok(/tiFieldNames\(\)/.test(pt), "protectedText also covers tiFieldNames (BoomBoys, Iron Wing)");

const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data.json"), "utf8"));
const handles = (data.teams || []).flatMap((t) => (t.players || []).map((p) => p.ign)).filter(Boolean);
ok(handles.length > 0, `data.json exposes ${handles.length} player handles via .ign`);
const clash = handles.filter((h) => dict[h]);
ok(!clash.length, "no real player handle collides with a dictionary key today", clash.join(", "));

console.log(fail ? `\n${fail} CHECK(S) FAILED` : "\nevery user-name render site is shielded");
process.exit(fail ? 1 : 0);
