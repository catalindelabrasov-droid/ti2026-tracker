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
    /* EVERY inline element that can carry words has to be listed here. The
       first version checked only b/strong/em, so it missed <i>at least</i> —
       which shipped and spliced "минимум" into an English sentence on the
       Teams tab. That was this exact class getting through a second time. */
    const INLINE = "b|strong|em|i|span|a|u|small|mark|code";

    /* An EMPTY inline element is decoration — a status dot, a pulse — not
       words, so it cannot be continuing a sentence. */
    const decorative = new RegExp(`<(${INLINE})[^>]*>\\s*</(${INLINE})>\\s*$`).test(n.before);

    /* The sentence runs INTO this node if what precedes it closes an inline
       element, and OUT of it if what follows opens one. */
    const openLeft = !decorative && new RegExp(`(</(${INLINE})>|\\})\\s*$`).test(n.before);
    const openRight = new RegExp(`^<\\s*(${INLINE})[ >]`).test(n.after);

    const commaEnd = /,$/.test(k);
    const lowerStart = /^[a-z]/.test(k) && !/^[a-z]+ [a-z]+ /.test(k);

    if ((openLeft && openRight) || commaEnd || (lowerStart && openLeft && openRight)) {
      bad.push({ k, ctx: (n.before.slice(-60) + "[[" + n.text + "]]" + n.after.slice(0, 60)).replace(/\s+/g, " ") });
      fail++;
      break;
    }
  }
}

/* ---------------------------------------------------------------------------
   SECOND FAILURE MODE: a translated head beside an untranslated tail.

   `<b>Eliminated</b> · ${note}` is two text nodes. "Eliminated" is a key, the
   tail is not, so /ru/ rendered "Вылетели · out of the tournament" — half
   Russian, half English, in one line. The check above cannot see it: its
   heuristic needs the key to sit BETWEEN two inline elements, and here the key
   IS the inline element.

   So: for every key that fills an inline element, look at the text immediately
   after the closing tag. If that text is English prose and is not itself a key,
   the pair renders mixed. */
const mixed = [];
const INLINE_TAGS = "b|strong|em|i|span|a|u|small|mark|code";
/* The tail must be what a TEXT NODE could hold. index.html builds markup inside
   template literals, so the characters after a closing tag are often JavaScript
   — backticks, ${…}, quotes, semicolons. Excluding them is the difference
   between three real findings and seventeen, fourteen of which were source code
   the browser never renders as text. */
const CODEY = /[`${}='"; ]\s*$|[`${}=;]|\bconst\b|\blet\b|\breturn\b|\/\*|\*\//;
/* The tail is captured up to the NEXT tag, not to an arbitrary length. A capped
   {2,90} truncated long tails, so the dictionary lookup below compared a prefix
   against a full key and reported an already-translated tail as missing. */
/* Respect data-noloc exactly as localize() does — it skips anything inside
   closest("[data-noloc]"), so a checker that ignores it reports a mix on markup
   the runtime never touches. The span is the element itself: from its opening
   tag to the matching close, not a guess based on distance. */
const NOLOC = [];
for (const m of src.matchAll(/<([a-z0-9]+)[^>]*\bdata-noloc\b[^>]*>/gi)) {
  const tag = m[1];
  const end = src.indexOf(`</${tag}>`, m.index);
  NOLOC.push([m.index, end < 0 ? m.index + m[0].length : end]);
}
const inNoloc = (i) => NOLOC.some(([a, b]) => i >= a && i <= b);

for (const m of src.matchAll(new RegExp(`<(${INLINE_TAGS})[^>]*>([^<>{}\`]{2,60})</\\1>([^<>\`]{2,400})(?=<)`, "g"))) {
  if (inNoloc(m.index)) continue;                  // localize() never sees it
  const head = decode(m[2]).replace(/\s+/g, " ").trim();
  const tailRaw = decode(m[3]).replace(/\s+/g, " ").trim();
  if (!dict[head]) continue;                       // head not translated: no mix
  if (CODEY.test(tailRaw)) continue;               // JS, not a rendered node
  /* Look up the node EXACTLY as the DOM holds it, separator and all. Stripping
     the leading "— " before the lookup compared a trimmed string against a key
     that still carried it, and reported already-translated tails as missing. */
  if (dict[tailRaw]) continue;                     // both halves translated
  /* The stripped form is only used to judge "is this prose", never as a key. */
  const words = tailRaw.replace(/^[·•\-–—:,.|]+\s*/, "").trim();
  if (!words) continue;                            // separator only
  if (!/[A-Za-z]{3,}\s+[A-Za-z]{2,}/.test(words)) continue;  // not prose
  mixed.push({ head, tail: tailRaw, ctx: m[0].replace(/\s+/g, " ").slice(0, 100) });
}

console.log(`${keys.length} dictionary keys checked against index.html\n`);

if (mixed.length) {
  console.log("MIXED LANGUAGE — a translated head with an untranslated tail.\nAdd the tail as its own key, or leave the head untranslated:\n");
  for (const x of mixed) {
    console.log(`  <b>${x.head}</b> -> ${JSON.stringify(dict[x.head])}`);
    console.log(`      tail NOT translated: ${JSON.stringify(x.tail)}`);
    console.log(`      ${x.ctx}\n`);
    fail++;
  }
}
if (bad.length) {
  console.log("SENTENCE FRAGMENTS — remove these, or restructure the source so the\nlabel becomes its own text node:\n");
  for (const b of bad) console.log(`  ${JSON.stringify(b.k)} -> ${JSON.stringify(dict[b.k])}\n      ${b.ctx}\n`);
}
console.log(fail ? `${fail} FRAGMENT KEY(S) — do not ship` : "no fragment keys");
process.exit(fail ? 1 : 0);
