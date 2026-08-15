/* Pull ONLY the short, self-contained UI labels out of index.html.
 *
 * Run: node i18n/labels.js
 * Writes: i18n/labels.en.json
 *
 * This is the half of the problem that string extraction genuinely solves.
 * Buttons, tab names, column headers and status words are atomic: they carry
 * their whole meaning, they are not chopped by a ${…}, and a Russian
 * translation of one is a complete Russian phrase.
 *
 * Everything longer is deliberately excluded and handled as prose — see
 * FINDINGS.md. The 183 sentence fragments the naive pass produced are exactly
 * what this filter is built to keep out.
 */
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

const MAX_WORDS = 6;
const looksLikeCode = (s) =>
  /[{}`$<>\\]|=>|\|\||&&|==|\?\s*['"]|:\s*['"]|\bfunction\b|;\s*$|^\W*$/.test(s);

const isLabel = (s) => {
  const t = s.trim();
  if (t.length < 2 || t.length > 48) return false;
  if (looksLikeCode(t)) return false;
  if (t.split(/\s+/).length > MAX_WORDS) return false;
  if (!/[A-Za-z]{2}/.test(t)) return false;
  if (/^\d/.test(t)) return false;                 // "3 of 8 series decided" is a counted string
  if (/\b\d+\b/.test(t)) return false;             // anything numeric needs a plural rule instead
  if (/^(TBD|OG|Bo\d|LIVE|VS|vs|TI)$/.test(t)) return false;
  return true;
};

const found = new Map();
const note = (t, ctx) => {
  const s = t.replace(/\s+/g, " ").trim();
  if (!isLabel(s)) return;
  if (!found.has(s)) found.set(s, new Set());
  found.get(s).add(ctx);
};
const ctxAt = (i) => {
  const b = src.slice(Math.max(0, i - 200), i);
  const cls = [...b.matchAll(/class="([^"]{0,60})"/g)].pop();
  const fn = [...b.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)].pop();
  return [fn && fn[1], cls && "." + cls[1].split(" ")[0]].filter(Boolean).join(" ") || "—";
};

// Visible text between tags
for (const m of src.matchAll(/>([^<>${}]{2,48})</g)) note(m[1], ctxAt(m.index));
// Attributes people read
for (const a of ["title", "placeholder", "aria-label"]) {
  for (const m of src.matchAll(new RegExp(a + '="([^"${}<>]{2,48})"', "g"))) note(m[1], ctxAt(m.index) + " @" + a);
}

const keys = [...found.keys()].sort((a, b) => a.localeCompare(b));
const out = {};
for (const k of keys) out[k] = "";                 // empty = not yet translated
fs.writeFileSync(path.join(__dirname, "labels.en.json"),
  JSON.stringify(Object.fromEntries(keys.map((k) => [k, k])), null, 2) + "\n");

console.log(`${keys.length} atomic UI labels`);
console.log("\nsample:");
keys.slice(0, 30).forEach((k) => console.log("  " + JSON.stringify(k) + "   [" + [...found.get(k)][0] + "]"));
