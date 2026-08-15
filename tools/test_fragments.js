/* Refuse to ship a dictionary key that is a sentence fragment.
 *
 * Run: node tools/test_fragments.js       (no dependencies)
 *
 * WHY THIS EXISTS
 *
 * The Russian layer swaps whole text nodes. index.html builds most of its
 * markup inside template literals, so a sentence like
 *
 *     grouped by record — first to <b>${WIN_TARGET} wins</b> goes through,
 *     <b>${LOSS_LIMIT} losses</b> knocks you out.
 *
 * is three text nodes, and the middle one is " goes through, ". Putting that in
 * the dictionary does not translate the sentence — it splices one Russian word
 * into an English one, which reads worse than leaving the whole line English.
 * Two such keys shipped to production before this test existed.
 *
 * i18n/FINDINGS.md argued exactly this before a single string was translated.
 * Writing it down was not enough; this makes it fail the build instead.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const dict = JSON.parse(fs.readFileSync(path.join(ROOT, "ru", "strings.json"), "utf8"));
const keys = Object.keys(dict).filter((k) => k.charAt(0) !== "_");

const decode = (s) =>
  s.replace(/&amp;/g, "&").replace(/&larr;/g, "←").replace(/&rarr;/g, "→")
   .replace(/&times;/g, "×").replace(/&nbsp;/g, " ");

const nodes = [];
for (const m of src.matchAll(/>([^<>]{1,300})</g)) {
  nodes.push({
    text: decode(m[1]).replace(/\s+/g, " ").trim(),
    before: src.slice(Math.max(0, m.index - 90), m.index + 1),
    after: src.slice(m.index + m[0].length - 1, m.index + m[0].length + 90),
  });
}

let fail = 0;
const bad = [];

for (const k of keys) {
  for (const n of nodes.filter((x) => x.text === k)) {
    /* The sentence continues INTO this node if what precedes it closes an
       inline emphasis or an interpolation — but NOT if it is a decorative
       empty element such as <span class="rl-live"></span>, which is a status
       dot rather than words. */
    const decorative = /<(span|i)[^>]*>\s*<\/(span|i)>\s*$/.test(n.before);
    const openLeft = !decorative && /(<\/b>|<\/strong>|<\/em>|\})\s*$/.test(n.before);

    /* ...and continues OUT of it if what follows opens emphasis that itself
       contains words, rather than a bare counter. */
    const nextTag = /^<\s*(b|strong|em)[ >]/.test(n.after);
    const openRight = nextTag;

    const commaEnd = /,$/.test(k);
    const lowerStart = /^[a-z]/.test(k) && !/^[a-z]+ [a-z]+ /.test(k);

    if ((openLeft && openRight) || commaEnd || (lowerStart && openLeft && openRight)) {
      bad.push({ k, ctx: (n.before.slice(-60) + "[[" + n.text + "]]" + n.after.slice(0, 60)).replace(/\s+/g, " ") });
      fail++;
      break;
    }
  }
}

console.log(`${keys.length} dictionary keys checked against index.html\n`);
if (bad.length) {
  console.log("SENTENCE FRAGMENTS — remove these, or restructure the source so the\nlabel becomes its own text node:\n");
  for (const b of bad) console.log(`  ${JSON.stringify(b.k)} -> ${JSON.stringify(dict[b.k])}\n      ${b.ctx}\n`);
}
console.log(fail ? `${fail} FRAGMENT KEY(S) — do not ship` : "no fragment keys");
process.exit(fail ? 1 : 0);
