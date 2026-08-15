/* The group-stage qualify/eliminate labels must agree with the real schedule.
 *
 * Run: node tools/test_swiss_thresholds.js      (no dependencies)
 *
 * WHY THIS EXISTS
 *
 * WIN_TARGET and LOSS_LIMIT were hard-coded to 3/3 with the comment
 * "16 teams, top 8 advance". They are 4/4. The board therefore told three teams
 * sitting at 1-3 they were "ELIMINATED · OUT OF THE TOURNAMENT" while they were
 * still scheduled to play round 5.
 *
 * The give-away was in data.json the whole time: HULIGANI is 0-4, which cannot
 * happen if a third loss ends your tournament. A race to N wins also runs up to
 * 2N-1 rounds, so "first to 3" cannot fit the 5 rounds this stage schedules.
 *
 * So this test does not check the constant. It reconstructs every record from
 * the completed matches and asserts the labels against what the schedule
 * actually did — the layer below the screen.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data.json"), "utf8"));
const src = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

let fail = 0;
const ok = (c, m, x) => { console.log((c ? "  ok   " : "  FAIL ") + m + (x ? "   " + x : "")); if (!c) fail++; };

const g = data.groupStage || {};
const rounds = g.rounds || [];
const ROUNDS = Math.max(1, rounds.length || 5);

/* The shipped derivation, lifted from index.html rather than re-typed. */
const m = /function swissTarget\(rounds\)\{([^}]*)\}/.exec(src);
if (!m) { console.error("swissTarget() not found in index.html"); process.exit(1); }
const swissTarget = new Function("rounds", m[1]);
const WIN_TARGET = swissTarget(ROUNDS);
const LOSS_LIMIT = WIN_TARGET;

console.log(`${ROUNDS} rounds -> WIN_TARGET ${WIN_TARGET}, LOSS_LIMIT ${LOSS_LIMIT}\n`);

/* Records, rebuilt from completed matches. */
const rec = {};
for (const r of rounds) for (const mt of r.matches || []) {
  if (mt.status !== "completed") continue;
  const a = mt.teamA || {}, b = mt.teamB || {};
  if (!a.name || !b.name) continue;
  rec[a.name] = rec[a.name] || [0, 0];
  rec[b.name] = rec[b.name] || [0, 0];
  if (a.score > b.score) { rec[a.name][0]++; rec[b.name][1]++; }
  else { rec[b.name][0]++; rec[a.name][1]++; }
}
const rows = Object.entries(rec).map(([team, [w, l]]) => ({ team, w, l }));
ok(rows.length > 0, `rebuilt ${rows.length} records from completed matches`);

/* WHEN a team became decided, not just whether it is now.
 *
 * Both checks below used to read the FINAL record and then ask about the final
 * round, which false-positives on anyone who reaches a threshold IN that round.
 * On 15 Aug 2026 OG and Xtreme Gaming both went into round 5 at 1-3 — alive,
 * correctly scheduled — lost, and finished 1-4. The test called that "kept
 * playing after hitting the loss limit" and "a decided team scheduled in Round
 * 5". Neither was true; they were decided BY that game, not before it.
 *
 * Contrast HULIGANI (0-4 in round 4) and TEAM VISION (4-0 in round 4), which
 * really were decided beforehand and really do sit round 5 out. That is the
 * behaviour these assertions exist to protect, and it still holds.
 *
 * So: replay each team's games in round order and record the round in which it
 * became decided. */
const decidedAtRound = {};   // team -> 1-based round it became decided, or null
const recordBefore = {};     // team -> [w,l] as of the end of round ROUNDS-1
{
  const run = {};
  rounds.forEach((r, idx) => {
    for (const mt of r.matches || []) {
      if (mt.status !== "completed") continue;
      const a = mt.teamA || {}, b = mt.teamB || {};
      if (!a.name || !b.name) continue;
      const winner = a.score > b.score ? a.name : b.name;
      for (const nm of [a.name, b.name]) {
        run[nm] = run[nm] || [0, 0];
        if (nm === winner) run[nm][0]++; else run[nm][1]++;
        if (decidedAtRound[nm] === undefined &&
            (run[nm][0] >= WIN_TARGET || run[nm][1] >= LOSS_LIMIT)) {
          decidedAtRound[nm] = idx + 1;
        }
      }
    }
    if (idx === rounds.length - 2) {
      for (const [nm, v] of Object.entries(run)) recordBefore[nm] = v.slice();
    }
  });
  for (const nm of Object.keys(run)) if (decidedAtRound[nm] === undefined) decidedAtRound[nm] = null;
  /* A one-round stage has no "before the last round"; fall back to zeroes so the
     cross-check below simply finds everyone undecided rather than throwing. */
  for (const nm of Object.keys(run)) if (!recordBefore[nm]) recordBefore[nm] = [0, 0];
}

/* 1. Nobody may exceed the thresholds. A team at 0-4 under a limit of 3 is the
      original bug, stated as an invariant. */
const over = rows.filter((r) => r.w > WIN_TARGET || r.l > LOSS_LIMIT);
ok(!over.length, "no record exceeds the thresholds",
   over.length ? over.map((r) => `${r.team} ${r.w}-${r.l}`).join(", ") : "");

/* 2. Anyone who played more games than a threshold allows proves the threshold
      wrong — this is the check that would have caught 3/3 on day one. */
const played = rows.map((r) => r.w + r.l);
const maxPlayed = Math.max(...played);
ok(maxPlayed <= ROUNDS, `most games played (${maxPlayed}) fits in ${ROUNDS} rounds`);
/* Played on AFTER being decided — measured against the round it became decided
   in, not against its final record. A team that hits the limit in its last game
   has games == that round and is fine; one that hits it in round 3 and shows up
   in round 4 is the real defect. */
const gamesOf = {};
rows.forEach((r) => { gamesOf[r.team] = r.w + r.l; });
const survivedPastLimit = rows.filter((r) => {
  const at = decidedAtRound[r.team];
  return at !== null && gamesOf[r.team] > at;
});
ok(!survivedPastLimit.length, "no team kept playing after it was decided",
   survivedPastLimit.map((r) => `${r.team} ${r.w}-${r.l}`).join(", "));

/* 3. The specific labels the user caught. */
const at = (w, l) => rows.filter((r) => r.w === w && r.l === l);
for (const r of at(1, 3)) {
  ok(r.l < LOSS_LIMIT, `${r.team} at 1-3 is NOT eliminated`, `${r.l} losses < ${LOSS_LIMIT}`);
}
for (const r of at(0, 4)) {
  ok(r.l >= LOSS_LIMIT, `${r.team} at 0-4 IS eliminated`, `${r.l} losses >= ${LOSS_LIMIT}`);
}
for (const r of at(3, 0)) {
  ok(r.w < WIN_TARGET, `${r.team} at 3-0 has NOT yet qualified`, `${r.w} wins < ${WIN_TARGET}`);
}

/* 4. Cross-check against the schedule: a team that is decided sits out the last
      round; a team that is not must still appear in it. */
const last = rounds[rounds.length - 1];
if (last && (last.matches || []).length) {
  const inLast = new Set();
  for (const mt of last.matches) {
    const a = (mt.teamA || {}).name, b = (mt.teamB || {}).name;
    if (a && a !== "TBD") inLast.add(a);
    if (b && b !== "TBD") inLast.add(b);
  }
  /* SAY when this cannot conclude anything.
     Every pairing in the final round is TBD until it is drawn, so `inLast` was
     a set containing the string "TBD" and nothing else — no real team could
     ever match, and "no decided team is scheduled" passed without examining a
     single pairing. Reporting that as a pass is the vacuous shape this repo
     produced eight times; it is skipped out loud now. */
  if (!inLast.size) {
    console.log(`         (${last.name} is not drawn yet — ${last.matches.length} TBD pairings, nothing to check)`);
  } else {
    /* Judged on the record BEFORE this round, which is the only record that
       could have determined whether a team was scheduled in it. Using the
       final record asks the schedule to have known results it could not. */
    const before = (r) => recordBefore[r.team] || [0, 0];
    const decided = rows.filter((r) => before(r)[0] >= WIN_TARGET || before(r)[1] >= LOSS_LIMIT);
    const undecided = rows.filter((r) => before(r)[0] < WIN_TARGET && before(r)[1] < LOSS_LIMIT);
    const wronglyPlaying = decided.filter((r) => inLast.has(r.team));
    const wronglySittingOut = undecided.filter((r) => !inLast.has(r.team));
    ok(!wronglyPlaying.length, `no decided team is scheduled in ${last.name}`,
       wronglyPlaying.map((r) => `${r.team} ${r.w}-${r.l}`).join(", "));
    /* Only meaningful once the draw is COMPLETE.
       Liquipedia publishes the final round a pairing at a time — right now 2 of
       7 have real teams and the other 5 are still TBD. Asserting "every
       undecided team is scheduled" the moment ANY pairing appears reports ten
       false failures on a perfectly normal partial draw, which is how this went
       red in CI within an hour of me writing it. */
    const fullyDrawn = inLast.size >= undecided.length;
    if (fullyDrawn) {
      ok(!wronglySittingOut.length, `every undecided team is scheduled in ${last.name}`,
         wronglySittingOut.map((r) => `${r.team} ${r.w}-${r.l}`).join(", "));
    } else {
      console.log(`         (${last.name} is partially drawn: ${inLast.size} of ` +
                  `${undecided.length} live teams paired — skipping the completeness check)`);
    }
    console.log(`         (${last.name}: ${last.matches.length} matches, ${inLast.size} real teams; ` +
                `${decided.length} decided, ${undecided.length} still alive)`);
  }
}

/* The three record-specific checks above iterate over whatever buckets exist
   today. Once the Swiss finishes, 1-3 and 3-0 stop existing and those loops run
   zero times — passing, printing nothing, verifying nothing about the bug they
   were written for. Count what was actually examined and fail if the whole
   section became a no-op. */
const examined = at(1, 3).length + at(0, 4).length + at(3, 0).length;
ok(examined > 0,
   "the record-specific checks examined at least one real team",
   examined ? `${examined} examined` : "0 — every bucket they name has emptied; " +
     "add the current buckets or move these to a synthetic fixture");

console.log(fail ? `\n${fail} CHECK(S) FAILED` : "\nall checks pass");
process.exit(fail ? 1 : 0);
