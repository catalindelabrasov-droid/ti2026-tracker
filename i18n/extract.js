/* Pull every user-visible English string out of the shipped pages.
 *
 * Run:  node i18n/extract.js
 * Writes: i18n/strings.en.json   (source of truth, regenerated)
 *         i18n/report.txt        (what it found and what it skipped)
 *
 * WHY IT WORKS THIS WAY
 *
 * index.html is one 6,400-line file with HTML, CSS and JS interleaved, and
 * almost all markup is built inside template literals. Rewriting 700 call sites
 * into t("key") calls would be a huge mechanical edit to a file that is serving
 * a live tournament — the single riskiest thing we could do to it.
 *
 * So the key IS the English string. That means:
 *   - no call sites change, so English cannot regress;
 *   - a translation is looked up by the text a user would actually read;
 *   - if someone edits an English string, its translation goes missing rather
 *     than silently showing the wrong thing. `node i18n/check.js` fails on that.
 *
 * The cost is that two identical English strings in different contexts share
 * one translation. Every such collision is listed in the report so it can be
 * disambiguated by hand if the Russian needs to differ.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PAGES = [
  "index.html", "watch.html", "guide.html",
  "legal.html", "delete-account.html", "app/index.html",
];

/* Things that look like prose but must NEVER be translated. */
const SKIP_EXACT = new Set([
  "TBD", "OG", "Bo3", "Bo5", "LIVE", "VS", "vs", "GG", "TI", "MMR",
]);
const SKIP_RE = [
  /^https?:\/\//i,            // urls
  /^[\d\s:.,%+-]+$/,          // pure numbers / scores / times
  /^[A-Z_]{2,}$/,             // CONSTANT_NAMES
  /^#[0-9a-f]{3,8}$/i,        // colours
  /^[a-z-]+\([^)]*\)$/i,      // css functions
  /^\W+$/,                    // punctuation only
  /^(px|em|rem|vh|vw|fr|deg|ms|s)$/i,
  /\bfunction\b|=>|;\s*$|^\s*\/\//,   // stray code
];

const isTranslatable = (s) => {
  const t = s.trim();
  if (t.length < 2 || t.length > 300) return false;
  if (SKIP_EXACT.has(t)) return false;
  if (SKIP_RE.some((re) => re.test(t))) return false;
  if (!/[A-Za-z]{2}/.test(t)) return false;       // needs real letters
  if (!/[a-z]/.test(t) && t.split(/\s+/).length < 2) return false; // lone ALLCAPS token
  return true;
};

/* Where a string was found, so a translator has context. */
function contextOf(src, index) {
  const before = src.slice(Math.max(0, index - 260), index);
  const cls = [...before.matchAll(/class="([^"]{0,80})"/g)].pop();
  const id = [...before.matchAll(/id="([^"]{0,40})"/g)].pop();
  const fn = [...before.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)].pop();
  return [fn && "fn:" + fn[1], id && "#" + id[1], cls && "." + cls[1].split(" ")[0]]
    .filter(Boolean).join(" ") || "—";
}

const found = new Map();   // english -> { pages:Set, contexts:Set, kinds:Set }
const add = (text, page, ctx, kind) => {
  const t = text.replace(/\s+/g, " ").trim();
  if (!isTranslatable(t)) return;
  if (!found.has(t)) found.set(t, { pages: new Set(), contexts: new Set(), kinds: new Set() });
  const e = found.get(t);
  e.pages.add(page); e.contexts.add(ctx); e.kinds.add(kind);
};

for (const page of PAGES) {
  const file = path.join(ROOT, page);
  if (!fs.existsSync(file)) continue;
  const src = fs.readFileSync(file, "utf8");

  // 1. Text between tags — the bulk of visible copy.
  for (const m of src.matchAll(/>([^<>]{2,300})</g)) {
    const raw = m[1];
    if (/[{}$]/.test(raw) && !/^[^${]*$/.test(raw)) {
      // Template literal: keep only the literal runs around ${...}
      raw.split(/\$\{[^}]*\}/).forEach((part) => add(part, page, contextOf(src, m.index), "text"));
    } else {
      add(raw, page, contextOf(src, m.index), "text");
    }
  }

  // 2. Attributes a user actually reads.
  for (const attr of ["title", "placeholder", "aria-label", "alt", "value"]) {
    const re = new RegExp(attr + '="([^"$<>]{2,200})"', "g");
    for (const m of src.matchAll(re)) add(m[1], page, contextOf(src, m.index) + " @" + attr, "attr");
  }

  // 3. Quoted strings assigned to visible text in JS (textContent/innerHTML = "...").
  for (const m of src.matchAll(/(?:textContent|innerHTML|innerText)\s*=\s*"([^"$<>]{2,200})"/g)) {
    add(m[1], page, contextOf(src, m.index) + " @js", "js");
  }
}

/* Stable, sorted output so a diff shows only real changes. */
const keys = [...found.keys()].sort((a, b) => a.localeCompare(b));
const en = {};
for (const k of keys) en[k] = k;
fs.writeFileSync(path.join(__dirname, "strings.en.json"), JSON.stringify(en, null, 2) + "\n");

const lines = [];
lines.push(`extracted ${keys.length} distinct strings from ${PAGES.length} pages`);
lines.push("");
const byPage = {};
for (const [s, e] of found) for (const p of e.pages) (byPage[p] = byPage[p] || []).push(s);
for (const p of PAGES) if (byPage[p]) lines.push(`  ${p.padEnd(24)} ${String(byPage[p].length).padStart(4)}`);
lines.push("");
lines.push("STRINGS USED IN MORE THAN ONE PLACE (one translation serves all —");
lines.push("split by hand if the Russian must differ):");
let shared = 0;
for (const [s, e] of found) {
  if (e.contexts.size > 1) {
    shared++;
    if (shared <= 40) lines.push(`  "${s.slice(0, 70)}"\n      ${[...e.contexts].slice(0, 4).join("  |  ")}`);
  }
}
lines.push(`  … ${shared} shared strings in total`);
fs.writeFileSync(path.join(__dirname, "report.txt"), lines.join("\n") + "\n");

console.log(lines.slice(0, 12).join("\n"));
console.log(`\nwrote i18n/strings.en.json (${keys.length} keys) and i18n/report.txt`);
