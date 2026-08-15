/* Every bucket subtitle must be true for the matches a team actually has left.
 *
 * Run: node tools/test_bucket_notes.js       (no dependencies)
 *
 * WHY THIS EXISTS
 *
 * The subtitle was `${WIN_TARGET-w} wins to qualify · ${LOSS_LIMIT-l} losses to
 * elimination`, computed with no knowledge of how many matches remained. On the
 * live board that produced:
 *
 *   3-0 bucket (2 matches left):  "1 win to qualify · 4 LOSSES to elimination"
 *   1-3 bucket (1 match left):    "3 WINS to qualify · 1 loss to elimination"
 *
 * You cannot lose four more times in two matches, or win three more in one.
 *
 * AND WHY IT NEARLY DIDN'T
 *
 * The first version of this file claimed to lift the note logic and instead
 * kept a hand-copy. When the labels were rewritten for three outcomes it went
 * on asserting against the OLD strings — none of which the product emits any
 * more — and stayed green while giving the shipped labels zero coverage. A
 * duplicated implementation only ever tests itself. It is extracted from
 * index.html now, and throws if the markers move rather than silently testing
 * nothing.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data.json"), "utf8"));

const ROUNDS = Math.max(1, ((data.groupStage || {}).rounds || []).length || 5);

const st = /function swissTarget\(rounds\)\{([^}]*)\}/.exec(src);
if (!st) { console.error("swissTarget() not found in index.html"); process.exit(1); }
const WIN_TARGET = new Function("rounds", st[1])(ROUNDS);
const LOSS_LIMIT = WIN_TARGET;

/* TWO ranges. The language helpers (plural / T / winsFor / lossesFor) sit ABOVE
   the bucket map, because the elimination section below needs T() as well.
   Lifting only the second range leaves T undefined and this file fails loudly —
   which is correct. It is not widened blindly: if the markers move again it must
   break rather than quietly test less. */
const H_START = "const plural=(n,one,few,many)";
const H_END = "const board=keys.map(k=>{";      // helpers end where the map begins
const hFrom = src.indexOf(H_START);
const hTo = src.indexOf(H_END, hFrom);
const from = src.indexOf("const qual=w>=WIN_TARGET");
const to = src.indexOf("const teams=arr.map", from);
if (hFrom < 0 || hTo < 0 || from < 0 || to < 0) {
  console.error("could not lift the note logic from renderGroups — markers moved");
  process.exit(1);
}
const helpers = src.slice(hFrom, hTo);
const block = src.slice(from, to);
if (!/const note\s*=/.test(block) || !/const T=/.test(helpers) || !/plural/.test(helpers)) {
  console.error("lifted text is missing `note`, `T` or `plural` — refusing to test nothing");
  process.exit(1);
}
/* LANG is injected, so the SAME shipped logic is exercised in both languages. */
const noteFn = new Function("w", "l", "WIN_TARGET", "LOSS_LIMIT", "ROUNDS", "LANG",
  helpers + "\n" + block + "\nreturn note;");
const noteIn = (lang, w, l) => noteFn(w, l, WIN_TARGET, LOSS_LIMIT, ROUNDS, lang);
const noteFor = (w, l) => noteIn("en", w, l);
/* LANG must be supplied here too — the helper block reads it to set RU. */
const pluralFn = new Function("n", "LANG",
  helpers + "\nreturn plural(n,'победа','победы','побед');").bind(null);
const pl = (n) => pluralFn(n, "ru");

let fail = 0;
const ok = (c, m, x) => { if (!c) { console.log("  FAIL " + m + (x ? "   " + x : "")); fail++; } };

console.log(`${ROUNDS} rounds · WIN_TARGET ${WIN_TARGET} · LOSS_LIMIT ${LOSS_LIMIT}`);
console.log("(note logic lifted from index.html, not re-typed)\n");
console.log("record  left  subtitle");

let checked = 0;
const seen = new Set();
for (let w = 0; w <= ROUNDS; w++) {
  for (let l = 0; l + w <= ROUNDS; l++) {
    if (w > WIN_TARGET || l > LOSS_LIMIT) continue;          // unreachable
    if (w >= WIN_TARGET && l >= LOSS_LIMIT) continue;        // impossible
    const decided = w >= WIN_TARGET || l >= LOSS_LIMIT;
    const left = decided ? 0 : Math.max(0, ROUNDS - (w + l));
    const txt = noteFor(w, l);
    checked++; seen.add(txt);
    console.log(`  ${w}-${l}     ${left}     ${txt}`);

    /* No clause may ask for more than the matches remaining. */
    const claimW = /(\d+) wins? for a playoff slot/.exec(txt);
    const claimL = /(\d+) loss(?:es)? and you're out/.exec(txt);
    ok(!claimW || Number(claimW[1]) <= left,
       `${w}-${l} asks for ${claimW && claimW[1]} more wins with ${left} match(es) left`, txt);
    ok(!claimL || Number(claimL[1]) <= left,
       `${w}-${l} asks for ${claimL && claimL[1]} more losses with ${left} match(es) left`, txt);

    ok(!/\b0 (wins?|loss(es)?)\b/.test(txt), `${w}-${l} says "0 wins/losses"`, txt);
    ok(txt.trim().length > 0, `${w}-${l} has an empty subtitle`);
    ok(!/ · $|^ · |· ·/.test(txt), `${w}-${l} has a dangling separator`, txt);

    /* A decided team gets one statement, not a path. */
    if (w >= WIN_TARGET) ok(txt === "straight to the playoffs", `${w}-${l} qualified but says: ${txt}`);
    if (l >= LOSS_LIMIT) ok(txt === "out of the tournament", `${w}-${l} eliminated but says: ${txt}`);

    /* Finished the Swiss undecided => the elimination round, nothing vaguer. */
    if (!decided && left === 0) {
      ok(txt === "to the elimination round", `${w}-${l} finished the Swiss but says: ${txt}`, txt);
    }
  }
}

/* The labels must actually be the current ones. If the product is rewritten and
   this file is not, that is the failure mode this whole file exists to avoid. */
/* RUSSIAN. These subtitles carry a number, so no dictionary entry can match
   them — they are composed per language, and a missed branch shows English on
   the Russian board. Three of them did, until today. */
for (let w = 0; w <= ROUNDS; w++) {
  for (let l = 0; l + w <= ROUNDS; l++) {
    if (w > WIN_TARGET || l > LOSS_LIMIT) continue;
    if (w >= WIN_TARGET && l >= LOSS_LIMIT) continue;
    const ru = noteIn("ru", w, l);
    ok(/[А-яЁё]/.test(ru), `${w}-${l} russian subtitle is not Russian`, ru);
    ok(!/(win|wins|loss|losses|playoff|elimination|reach|either way)/i.test(ru),
       `${w}-${l} russian subtitle still has English words`, ru);
  }
}

/* Russian plural is three forms chosen by the LAST TWO digits: 11 behaves like
   "many" while 21 behaves like "one". A last-digit-only rule gets both wrong. */
const PLURAL = [[1,"победа"],[2,"победы"],[4,"победы"],[5,"побед"],[11,"побед"],
                [12,"побед"],[14,"побед"],[21,"победа"],[22,"победы"],[25,"побед"],
                [0,"побед"],[101,"победа"],[111,"побед"]];
for (const [n, want] of PLURAL) ok(pl(n) === want, `plural(${n}) = "${want}"`, pl(n));
console.log(`  plural checked at n = ${PLURAL.map(([n]) => n).join(", ")}`);

const joined = [...seen].join(" | ");
ok(!/to qualify|to elimination|placing decided|awaiting the final/.test(joined),
   "no retired label survives", joined);
ok(/for a playoff slot/.test(joined), "the playoff-slot wording is exercised");
ok(/to the elimination round/.test(joined), "the elimination-round wording is exercised");

console.log(`\n${checked} reachable records checked, ${seen.size} distinct subtitles`);
console.log(fail ? `${fail} CHECK(S) FAILED` : "every subtitle is true for the matches remaining");
process.exit(fail ? 1 : 0);
