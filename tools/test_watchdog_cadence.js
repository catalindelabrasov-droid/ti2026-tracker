/* The watchdog must not fire on a healthy schedule.
 *
 * Run: node tools/test_watchdog_cadence.js
 *
 * WHY THIS EXISTS
 *
 * updater-watchdog pokes the updater when published data is older than
 * STALE_MIN. It is meant to fire only when the scheduled run has FAILED.
 *
 * STALE_MIN was lowered to 45 while pg_cron dispatches HOURLY. Punctual hourly
 * data still ages to 59 minutes before the next run, so the watchdog woke every
 * single hour at about :50 and poked a run that was not late - it simply had
 * not happened yet. The commit log carried a permanent :51 / :01 pair, i.e. two
 * full runs an hour.
 *
 * The cost was not the extra run. Every data commit triggers a full Netlify
 * rebuild, so double-firing doubled the build burn: measured 17 Aug 2026, 33
 * deploys in a partial day and ~1,325 build minutes projected per 30 days
 * against a 300-minute allowance. The credit ran out overnight, deploys were
 * skipped for six hours, and a corrupted data.json stayed live the whole time
 * because no fix could be published.
 *
 * This asserts the invariant that was violated, not the number: STALE_MIN must
 * exceed the dispatch interval with a margin. If the cadence ever changes to
 * every 30 minutes, lower STALE_MIN and update DISPATCH_MIN here together.
 */
const fs = require("fs");
const path = require("path");

let fail = 0;
const ok = (cond, msg, extra) => {
  console.log((cond ? "  ok   " : "  FAIL ") + msg + (extra ? "   " + extra : ""));
  if (!cond) fail++;
};

const SRC = fs.readFileSync(
  path.join(path.dirname(__dirname), "supabase", "functions", "updater-watchdog", "index.ts"),
  "utf8");

const num = (name) => {
  const m = SRC.match(new RegExp("const\\s+" + name + "\\s*=\\s*(\\d+)"));
  return m ? Number(m[1]) : null;
};

const STALE_MIN = num("STALE_MIN");
const COOLDOWN_MIN = num("COOLDOWN_MIN");

/* What pg_cron actually dispatches on. Not readable from this repo - the
   schedule lives in the Supabase database - so it is stated here and the
   comment in index.ts must agree with it. */
const DISPATCH_MIN = 60;

console.log("the constants are readable");
ok(STALE_MIN !== null, "STALE_MIN found", String(STALE_MIN));
ok(COOLDOWN_MIN !== null, "COOLDOWN_MIN found", String(COOLDOWN_MIN));

console.log("\nthe invariant: a healthy schedule must never trip the watchdog");
ok(STALE_MIN > DISPATCH_MIN,
   `STALE_MIN (${STALE_MIN}) exceeds the ${DISPATCH_MIN}-minute dispatch interval`,
   STALE_MIN > DISPATCH_MIN ? "" : "-> fires every cycle on healthy data");
ok(STALE_MIN >= DISPATCH_MIN + 10,
   "and leaves at least a 10-minute margin for a slightly late run",
   `margin ${STALE_MIN - DISPATCH_MIN} min`);

console.log("\nthe scenario that actually happened");
/* Age of the published data just before the next scheduled run lands. */
const ageBeforeNextRun = DISPATCH_MIN - 1;
ok(ageBeforeNextRun < STALE_MIN,
   `data ${ageBeforeNextRun} min old just before a punctual run does NOT trip it`,
   `${ageBeforeNextRun} < ${STALE_MIN}`);
/* And the case it exists for: a run that never happened at all. */
const ageAfterMissedRun = DISPATCH_MIN * 2 + 5;
ok(ageAfterMissedRun > STALE_MIN,
   `a genuinely missed run (${ageAfterMissedRun} min old) still trips it`,
   `${ageAfterMissedRun} > ${STALE_MIN}`);

console.log("\nthe cooldown still bounds a broken updater");
ok(COOLDOWN_MIN > 0 && COOLDOWN_MIN <= DISPATCH_MIN,
   "COOLDOWN_MIN keeps retries to at most one per dispatch interval",
   String(COOLDOWN_MIN));

console.log("\nthe comment has not drifted from the constant");
ok(/dispatches hourly|hourly/i.test(SRC),
   "index.ts still describes an hourly dispatch", "");
ok(!/const STALE_MIN = 45/.test(SRC),
   "the 45-minute value that caused the double-fire is gone", "");

console.log();
console.log(fail ? fail + " FAILURE(S)" : "all good");
process.exit(fail ? 1 : 0);
