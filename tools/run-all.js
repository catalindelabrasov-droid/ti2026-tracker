/* Run every test, then report. Do NOT stop at the first failure.
 *
 * `npm test` chained the files with `&&`, so the first red file aborted the run
 * and everything after it went unreported.
 *
 * Files are DISCOVERED, not listed — a hand-maintained list is why
 * test_pick_series.py sat unrun for weeks while guarding the code that rewrites
 * data.json every 15 minutes in production. But discovery inherited the
 * mirror-image blindness: nothing noticed a file LEAVING the set. Deleting 12 of
 * 13 files reported "all 2 test files passed", exit 0; renaming one to the
 * common `*.test.js` convention made it vanish just as quietly. Hence the floor.
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const ROOT = path.join(DIR, "..");
const results = [];

/* A hung test must not hold CI to the 6-hour Actions ceiling. */
const TIMEOUT_MS = 120000;

const banner = (status, name) => {
  const line = "=".repeat(64);
  console.log(`\n${line}\n${status}  ${name}\n${line}`);
};

const record = (f, r, kind) => {
  const out = (r.stdout || "") + (r.stderr || "");
  const timedOut = r.error && r.error.code === "ETIMEDOUT";
  const code = timedOut ? 1 : r.status;
  results.push({ f, code, out, kind });
  banner(timedOut ? "TIMEOUT" : code === 0 ? "PASS" : "FAIL", f);
  if (timedOut) console.log(`  killed after ${TIMEOUT_MS / 1000}s`);
  process.stdout.write(out.trimEnd() + "\n");
};

/* ---- JavaScript ---- */
const jsFiles = fs.readdirSync(DIR).filter((f) => /^test_.*\.js$/.test(f)).sort();
const EXPECTED_JS = 31;   /* + tools/test_bracket_assertion.js, 19 Aug */
if (jsFiles.length < EXPECTED_JS) {
  console.error(`Expected at least ${EXPECTED_JS} test_*.js files in tools/, found ${jsFiles.length}.`);
  console.error(`Found: ${jsFiles.join(", ") || "(none)"}`);
  console.error("A test file was deleted, renamed, or moved into a subdirectory.");
  console.error("If that was deliberate, lower EXPECTED_JS in tools/run-all.js.");
  process.exit(1);
}
for (const f of jsFiles) {
    /* --strict on the budget test. Without it the file reports REGRESSION and
     exits 0, so npm test passed on a declared regression — it was already in
     one at HEAD (37 -> 38) and nobody would ever have seen it. */
  const argv = f === "test_ru_completeness.js" ? [path.join(DIR, f), "--strict"] : [path.join(DIR, f)];
  record(f, spawnSync(process.execPath, argv,
    { encoding: "utf8", cwd: ROOT, timeout: TIMEOUT_MS }), "js");
}

/* ---- Python ---- */
const pyFiles = fs.readdirSync(DIR).filter((f) => /^test_.*\.py$/.test(f)).sort();
/* The Python side had no floor at all until 19 Aug, which made it the softer
   target: deleting BOTH guard files - test_no_future_results.py and
   test_opendota_future_merge.py, the two that stand between the updater and a
   repeat of the fabricated bracket - left `npm test` printing "all 33 test
   files passed" and exiting 0. */
const EXPECTED_PY = 6;
if (pyFiles.length < EXPECTED_PY) {
  console.error(`Expected at least ${EXPECTED_PY} test_*.py files in tools/, found ${pyFiles.length}.`);
  console.error(`Found: ${pyFiles.join(", ") || "(none)"}`);
  console.error("A test file was deleted, renamed, or moved into a subdirectory.");
  console.error("If that was deliberate, lower EXPECTED_PY in tools/run-all.js.");
  process.exit(1);
}
for (const f of pyFiles) {
  let r = spawnSync("python", [path.join(DIR, f)], { encoding: "utf8", cwd: ROOT, timeout: TIMEOUT_MS });
  if (r.error && r.error.code === "ENOENT") {
    r = spawnSync("python3", [path.join(DIR, f)], { encoding: "utf8", cwd: ROOT, timeout: TIMEOUT_MS });
  }
  if (r.error && r.error.code === "ENOENT") {
    /* A SKIP is NOT a pass. It used to be pushed with code 0, so it counted in
       "all 14 test files passed" — the one line a CI badge or a skimmed log
       actually shows, immediately contradicting the warning above it. */
    console.log(`\nSKIP  ${f} — no python on PATH. This file is UNVERIFIED.`);
    results.push({ f, code: 0, skipped: true, out: "", kind: "py" });
    continue;
  }
  record(f, r, "py");
}

/* ---- summary ---- */
const failed = results.filter((r) => r.code !== 0);
const skipped = results.filter((r) => r.skipped);
const ran = results.filter((r) => !r.skipped);
const rule = "-".repeat(64);
console.log(`\n${rule}`);
for (const r of results) {
  console.log(`  ${r.skipped ? "SKIP" : r.code === 0 ? "pass" : "FAIL"}  ${r.f}`);
}
console.log(rule);
if (failed.length) {
  console.log(`${failed.length} of ${results.length} test files FAILED: ${failed.map((r) => r.f).join(", ")}`);
} else if (skipped.length) {
  /* Never say "all N passed" when some were not run. */
  console.log(`${ran.length} test files passed, ${skipped.length} SKIPPED and unverified: ${skipped.map((r) => r.f).join(", ")}`);
} else {
  console.log(`all ${ran.length} test files passed`);
}
process.exit(failed.length ? 1 : 0);
