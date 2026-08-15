/* Run every test, then report. Do NOT stop at the first failure.
 *
 * `npm test` chained the files with `&&`, so the first red file aborted the run
 * and everything after it went unreported — you fixed one, re-ran, found the
 * next, and never saw the shape of the whole. This runs all of them and exits
 * non-zero if any failed.
 *
 * Files are DISCOVERED, not listed. A hand-maintained list is how
 * test_pick_series.py sat unrun for weeks while guarding _pick_series in
 * update_data.py — the code that rewrites data.json every 15 minutes in
 * production.
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const ROOT = path.join(DIR, "..");
const results = [];

const banner = (status, name) => {
  const line = "=".repeat(64);
  console.log(`\n${line}\n${status}  ${name}\n${line}`);
};

/* ---- JavaScript ---- */
const jsFiles = fs.readdirSync(DIR).filter((f) => /^test_.*\.js$/.test(f)).sort();
if (!jsFiles.length) {
  console.error("no test_*.js found in tools/ — refusing to report success");
  process.exit(1);
}
for (const f of jsFiles) {
  const r = spawnSync(process.execPath, [path.join(DIR, f)], { encoding: "utf8", cwd: ROOT });
  const out = (r.stdout || "") + (r.stderr || "");
  results.push({ f, code: r.status, out });
  banner(r.status === 0 ? "PASS" : "FAIL", f);
  process.stdout.write(out.trimEnd() + "\n");
}

/* ---- Python ---- */
const pyFiles = fs.readdirSync(DIR).filter((f) => /^test_.*\.py$/.test(f)).sort();
for (const f of pyFiles) {
  let r = spawnSync("python", [path.join(DIR, f)], { encoding: "utf8", cwd: ROOT });
  if (r.error) r = spawnSync("python3", [path.join(DIR, f)], { encoding: "utf8", cwd: ROOT });
  if (r.error) {
    /* Loud, and it does not count as a pass. */
    console.log(`\nSKIP  ${f} — no python on PATH (this file is UNVERIFIED)`);
    results.push({ f, code: 0, skipped: true, out: "" });
    continue;
  }
  const out = (r.stdout || "") + (r.stderr || "");
  results.push({ f, code: r.status, out });
  banner(r.status === 0 ? "PASS" : "FAIL", f);
  process.stdout.write(out.trimEnd() + "\n");
}

/* ---- summary ---- */
const failed = results.filter((r) => r.code !== 0);
const skipped = results.filter((r) => r.skipped);
const rule = "-".repeat(64);
console.log(`\n${rule}`);
for (const r of results) {
  console.log(`  ${r.skipped ? "SKIP" : r.code === 0 ? "pass" : "FAIL"}  ${r.f}`);
}
console.log(rule);
if (skipped.length) console.log(`${skipped.length} file(s) SKIPPED — those are unverified, not passing.`);
console.log(failed.length
  ? `${failed.length} of ${results.length} test files FAILED: ${failed.map((r) => r.f).join(", ")}`
  : `all ${results.length} test files passed`);
process.exit(failed.length ? 1 : 0);
