/* The Russian share card must actually be Russian.
 *
 * Run: node tools/test_ru_social_meta.js
 *
 * WHY THIS EXISTS
 *
 * /ru/ and / are one document localised in the browser, and crawlers do not run
 * JavaScript, so a link to /ru/ shared into Telegram or VK unfurled with the
 * English description and the English image. netlify/edge-functions/ru-social-meta.js
 * rewrites those tags at the edge. This checks the rewrite against the REAL
 * index.html rather than a fixture, so the day someone renames or reorders a
 * meta tag, this goes red instead of the card silently reverting to English.
 *
 * MUTATION CHECK (the point of the file)
 *   - empty every SWAPS entry            -> "og:description is Russian" FAILS
 *   - drop the og:image swap             -> "og:image points at the RU image" FAILS
 *   - translate the tournament name      -> "the tournament name is untouched" FAILS
 *   - make ruMeta() return html unchanged -> six checks FAIL at once
 * Verified by hand on 2026-08-16: each of the four above produces a red run.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.dirname(__dirname);
let fail = 0;

function ok(cond, msg, extra) {
  console.log((cond ? "  ok   " : "  FAIL ") + msg + (extra ? "   " + extra : ""));
  if (!cond) fail++;
}

/* The edge function is an ES module for Deno; pull the two exports out by hand
   so this test needs no bundler and no edge runtime. */
const src = fs.readFileSync(
  path.join(ROOT, "netlify", "edge-functions", "ru-social-meta.js"), "utf8");
const body = src
  .replace(/^export function ruMeta/m, "function ruMeta")
  .replace(/^export default[\s\S]*$/m, "")
  .replace(/^export /gm, "");
const ruMeta = new Function(body + "\nreturn ruMeta;")();

const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const out = ruMeta(html);

const get = (h, re) => { const m = h.match(re); return m ? m[1] : null; };
const CYR = /[Ѐ-ӿ]/;

console.log("the English page is the starting point");
ok(!CYR.test(get(html, /property="og:description" content="([^"]*)"/) || ""),
   "index.html ships an English og:description", "");
ok((html.match(/property="og:/g) || []).length >= 8,
   "index.html has the og block at all",
   String((html.match(/property="og:/g) || []).length));

console.log("\nthe rewrite produces a Russian card");
const d = get(out, /property="og:description" content="([^"]*)"/);
ok(CYR.test(d || ""), "og:description is Russian", (d || "").slice(0, 46) + "…");

const td = get(out, /name="twitter:description" content="([^"]*)"/);
ok(CYR.test(td || ""), "twitter:description is Russian", "");

const t = get(out, /property="og:title" content="([^"]*)"/);
ok(CYR.test(t || ""), "og:title carries Russian", t);

ok(get(out, /property="og:locale" content="([^"]*)"/) === "ru_RU",
   "og:locale is ru_RU", String(get(out, /property="og:locale" content="([^"]*)"/)));
ok(get(out, /property="og:locale:alternate" content="([^"]*)"/) === "en_US",
   "og:locale:alternate is en_US", "");

const img = get(out, /property="og:image" content="([^"]*)"/);
ok(img === "https://dota2tileague.com/og-image-ru.png",
   "og:image points at the RU image", String(img));
ok(get(out, /name="twitter:image" content="([^"]*)"/) === img,
   "twitter:image matches it", "");

console.log("\nthe tournament name is NOT translated");
ok((t || "").includes("The International 2026"),
   "the tournament name is untouched — it is a proper noun", t);

console.log("\nnothing else moved");
ok(out.length !== html.length, "the document actually changed", "");
const strip = (s) => s.replace(/<meta (property="og:|name="twitter:)[^>]*>/g, "");
ok(strip(out) === strip(html),
   "every difference is inside an og:/twitter: meta tag — nothing else was rewritten", "");
ok(get(out, /name="description" content="([^"]*)"/) ===
   get(html, /name="description" content="([^"]*)"/),
   "the plain <meta name=description> is left alone", "");

console.log("\nthe RU image exists and is a real PNG of the right size");
const p = path.join(ROOT, "og-image-ru.png");
ok(fs.existsSync(p), "og-image-ru.png is committed", "");
if (fs.existsSync(p)) {
  const buf = fs.readFileSync(p);
  ok(buf.slice(1, 4).toString() === "PNG", "it is a PNG", "");
  ok(buf.readUInt32BE(16) === 1200 && buf.readUInt32BE(20) === 630,
     "it is 1200x630", buf.readUInt32BE(16) + "x" + buf.readUInt32BE(20));
}

console.log("\nrunning it twice changes nothing further (idempotent)");
ok(ruMeta(out) === out, "a second pass is a no-op", "");

console.log();
console.log(fail ? fail + " FAILURE(S)" : "all good");
process.exit(fail ? 1 : 0);
