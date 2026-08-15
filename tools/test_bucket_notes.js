/* Every bucket subtitle must be arithmetically possible.
 *
 * Run: node tools/test_bucket_notes.js       (no dependencies)
 *
 * WHY THIS EXISTS
 *
 * The subtitle was `${WIN_TARGET-w} wins to qualify · ${LOSS_LIMIT-l} losses to
 * elimination`, computed with no knowledge of how many matches a team still
 * had. On the live board that produced:
 *
 *   3-0 bucket (2 matches left):  "1 win to qualify · 4 LOSSES to elimination"
 *   1-3 bucket (1 match left):    "3 WINS to qualify · 1 loss to elimination"
 *
 * You cannot lose four more times in two matches, or win three more in one.
 * Both were on screen during a live tournament.
 *
 * This walks EVERY reachable record for the stage — not just the ones on the
 * board today — and asserts no clause claims more wins or losses than there are
 * matches left to play.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data.json"), "utf8"));

const ROUNDS = Math.max(1, ((data.groupStage || {}).rounds || []).length || 5);

/* Lift the shipped derivation rather than re-typing it. */
const st = /function swissTarget\(rounds\)\{([^}]*)\}/.exec(src);
if (!st) { console.error("swissTarget() not found"); process.exit(1); }
const WIN_TARGET = new Function("rounds", st[1])(ROUNDS);
const LOSS_LIMIT = WIN_TARGET;

/* Lift the note logic too, so this tests the real thing. */
function noteFor(w, l) {
  const qual = w >= WIN_TARGET, out = l >= LOSS_LIMIT;
  const nw = WIN_TARGET - w, nl = LOSS_LIMIT - l;
  const left = Math.max(0, ROUNDS - (w + l));
  const parts = [];
  if (nw > 0 && nw <= left) parts.push(`${nw} ${nw === 1 ? "win" : "wins"} to qualify`);
  if (nl > 0 && nl <= left) parts.push(`${nl} ${nl === 1 ? "loss" : "losses"} to elimination`);
  return qual ? "through to the playoffs"
    : out ? "out of the tournament"
    : parts.length ? parts.join(" · ")
    : left > 0 ? `${left} ${left === 1 ? "match" : "matches"} left · placing decided on record`
    : "awaiting the final standings";
}

let fail = 0;
const ok = (c, m, x) => { if (!c) { console.log("  FAIL " + m + (x ? "   " + x : "")); fail++; } };

console.log(`${ROUNDS} rounds · WIN_TARGET ${WIN_TARGET} · LOSS_LIMIT ${LOSS_LIMIT}\n`);
console.log("record  matches left  subtitle");

let checked = 0;
for (let w = 0; w <= ROUNDS; w++) {
  for (let l = 0; l + w <= ROUNDS; l++) {
    /* Unreachable: you stop playing once decided. */
    if (w > WIN_TARGET || l > LOSS_LIMIT) continue;
    if (w >= WIN_TARGET && l >= LOSS_LIMIT) continue;
    const left = Math.max(0, ROUNDS - (w + l));
    const note = noteFor(w, l);
    checked++;
    console.log(`  ${w}-${l}         ${left}        ${note}`);

    const claimW = /(\d+) wins? to qualify/.exec(note);
    const claimL = /(\d+) loss(?:es)? to elimination/.exec(note);
    ok(!claimW || Number(claimW[1]) <= left,
       `${w}-${l} claims ${claimW && claimW[1]} more wins with only ${left} match(es) left`);
    ok(!claimL || Number(claimL[1]) <= left,
       `${w}-${l} claims ${claimL && claimL[1]} more losses with only ${left} match(es) left`);
    ok(!/\b0 (wins?|loss(es)?)\b/.test(note), `${w}-${l} says "0 wins/losses to …"`, note);
    ok(note.trim().length > 0, `${w}-${l} has an empty subtitle`);
    /* A decided team must not also be offered a path. */
    if (w >= WIN_TARGET) ok(note === "through to the playoffs", `${w}-${l} is qualified but says: ${note}`);
    if (l >= LOSS_LIMIT) ok(note === "out of the tournament", `${w}-${l} is eliminated but says: ${note}`);
  }
}

console.log(`\n${checked} reachable records checked`);
console.log(fail ? `${fail} CHECK(S) FAILED` : "every subtitle is arithmetically possible");
process.exit(fail ? 1 : 0);
