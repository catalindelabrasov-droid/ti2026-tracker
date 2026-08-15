/* Every internal link must resolve to a real file from EVERY language prefix.
 *
 * Run: node tools/test_lang_paths.js       (needs jsdom)
 *
 * WHY THIS EXISTS
 *
 * The site answers on three prefixes: "/", "/en/" and "/ru/". They are the same
 * document — only the prefix differs. P() built the link targets and returned a
 * RELATIVE path for English:
 *
 *     function P(page){ return LANG==="ru" ? "/ru/"+page : page; }
 *
 * A relative "watch.html" resolves against the current directory. From "/" that
 * is "/watch.html" and correct; from "/en/" it is "/en/watch.html", and nothing
 * served that. In production /en/watch.html, /en/guide.html, /en/legal.html and
 * /en/delete-account.html were all 404 — every sub-page link on the English
 * escape hatch was dead, which is the page a Russian-speaking reader lands on
 * precisely because they asked for English.
 *
 * The Russian branch was absolute and therefore fine, which is why nothing
 * caught it: testing /ru/ proved nothing about /en/.
 *
 * So the invariant is not "P() is correct" — it is that from each prefix the
 * site serves, every link the page emits lands on a real file, after Netlify's
 * rules are applied. That is what this checks.
 */
const fs = require("fs");
const path = require("path");

let JSDOM;
try { ({ JSDOM } = require("jsdom")); }
catch (e) { console.error("CANNOT RUN: jsdom missing.  npm install"); process.exit(1); }

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const toml = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8");
const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data.json"), "utf8"));
const script = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/.exec(html)[1].replace(/\ninit\(\);?/, "\n");

let fail = 0;
const ok = (c, m, x) => { console.log((c ? "  ok   " : "  FAIL ") + m + (x ? "   " + x : "")); if (!c) fail++; };

/* ---------- Netlify's rules, in order, comments stripped ------------------ */
const rules = [];
{
  const body = toml.replace(/^\s*#.*$/gm, "");
  const re = /\[\[redirects\]\]([\s\S]*?)(?=\[\[|\[build|\Z|$)/g;
  let m;
  while ((m = re.exec(body))) {
    const blk = m[1];
    const from = /from\s*=\s*"([^"]+)"/.exec(blk);
    const to = /to\s*=\s*"([^"]+)"/.exec(blk);
    const st = /status\s*=\s*(\d+)/.exec(blk);
    const cond = /conditions\s*=/.test(blk);
    if (from && to) rules.push({ from: from[1], to: to[1], status: st ? +st[1] : 301, cond });
  }
}
ok(rules.length >= 4, `parsed ${rules.length} redirect rules from netlify.toml`);

/* Resolve a path the way the CDN would: a real file wins over a non-forced
   rule; otherwise first matching rule wins. Netlify ignores a trailing slash. */
const exists = (p) => {
  const rel = p.replace(/^\//, "").split("?")[0].split("#")[0];
  if (!rel) return fs.existsSync(path.join(ROOT, "index.html"));
  try { const s = fs.statSync(path.join(ROOT, rel)); return s.isFile(); } catch (e) { return false; }
};
/* "/app" is a real DIRECTORY holding index.html. A static host answers it with
   a 301 to "/app/" and then serves the index — so it is a working link, not a
   404, and the checker has to know the difference. */
const isDir = (p) => {
  const rel = p.replace(/^\//, "").split("?")[0].split("#")[0];
  if (!rel) return false;
  try { return fs.statSync(path.join(ROOT, rel)).isDirectory()
             && fs.existsSync(path.join(ROOT, rel, "index.html")); } catch (e) { return false; }
};
const slashless = (s) => (s.length > 1 ? s.replace(/\/+$/, "") : s);

function serve(p, depth) {
  if (depth > 5) return { okFile: false, why: "redirect loop" };
  if (exists(p)) return { okFile: true, why: "real file " + p, final: p };
  if (isDir(p)) return { okFile: true, why: "directory + index.html (301 to " + p + "/)", final: p + "/" };
  for (const r of rules) {
    if (r.cond) continue;                       // geo rules are not the subject here
    if (r.from.endsWith("/*")) {
      const base = r.from.slice(0, -1);         // "/en/"
      if (p.startsWith(base)) {
        const splat = p.slice(base.length);
        return serve(r.to.replace(":splat", splat), depth + 1);
      }
    } else if (slashless(r.from) === slashless(p)) {
      return serve(r.to, depth + 1);
    }
  }
  /* A bare directory falls back to its index file, as a static host would. */
  if (p.endsWith("/") && exists(p + "index.html")) return { okFile: true, why: "directory index", final: p + "index.html" };
  return { okFile: false, why: "404 — no file and no rule" };
}

/* ---------- collect the links the page actually emits --------------------- */
function linksFrom(prefix) {
  const dom = new JSDOM("<!doctype html><html><body><div id='app'></div></body></html>",
    { url: "https://dota2tileague.com" + prefix, runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window;
  w.fetch = () => Promise.resolve({ ok: false, json: async () => ({}), text: async () => "" });
  w.scrollTo = () => {};
  w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.console.error = () => {};
  const s = w.document.createElement("script");
  s.textContent = script;
  w.document.body.appendChild(s);
  w.render(data);

  const out = new Set();
  w.document.querySelectorAll("a[href]").forEach((a) => {
    const h = a.getAttribute("href");
    if (!h || /^(https?:|mailto:|tel:|#|javascript:)/i.test(h)) return;
    /* Resolve exactly as a browser would, against the current directory. */
    out.add(new w.URL(h, "https://dota2tileague.com" + prefix).pathname);
  });
  return [...out].sort();
}

const emitted = {};
for (const prefix of ["/", "/en/", "/ru/"]) {
  console.log(`\nlinks emitted on ${prefix}`);
  const links = emitted[prefix] = linksFrom(prefix);
  ok(links.length > 0, `page emits internal links`, String(links.length));
  for (const l of links) {
    const r = serve(l, 0);
    ok(r.okFile, `${l}`, r.okFile ? "" : r.why);
  }
}

/* ---------- the link TEXT itself, not just whether it resolves ------------
   This is the assertion that survives the redirect table. With the /en/*
   wildcard in place, a relative "watch.html" still resolves — the CDN quietly
   repairs it — so "does every link resolve" cannot tell a correct link from a
   rescued one. If the wildcard is ever removed or narrowed, a relative link is
   a 404 again. So require that /en/ emits exactly what / emits: absolute paths
   that do not depend on which directory the reader happens to be standing in. */
console.log("\n/en/ emits the same absolute links as /");
ok(JSON.stringify(emitted["/en/"]) === JSON.stringify(emitted["/"]),
   "identical link set on / and /en/",
   `/ = ${emitted["/"].join(" ")}   |   /en/ = ${emitted["/en/"].join(" ")}`);
const relOnEn = emitted["/en/"].filter((l) => l.startsWith("/en/"));
ok(relOnEn.length === 0,
   "no link on /en/ is directory-relative",
   relOnEn.join(", "));

/* ---------- a rewrite must land on the RIGHT file, not merely a file ------
   "/en/*" -> "/" would satisfy "it resolves" for every path while serving the
   homepage in place of every sub-page. Compare targets, not success. */
console.log("\n/en/X serves the same file as /X");
for (const page of ["watch.html", "guide.html", "legal.html", "delete-account.html"]) {
  const a = serve("/" + page, 0), b = serve("/en/" + page, 0);
  ok(a.okFile && b.okFile && a.final === b.final,
     `/en/${page} -> ${b.final || "404"}`,
     a.final === b.final ? "" : `expected ${a.final}`);
}

/* ---------- the specific URLs that were 404 in production ----------------- */
console.log("\nthe paths that were broken");
for (const p of ["/en/watch.html", "/en/guide.html", "/en/legal.html",
                 "/en/delete-account.html", "/en/index.html", "/en/"]) {
  const r = serve(p, 0);
  ok(r.okFile, p, r.okFile ? "" : r.why);
}

/* ---------- and the shield: /en/ must not fall through to "/" ------------- */
console.log("\nthe escape hatch is not undone by the wildcard");
const enExact = rules.findIndex((r) => slashless(r.from) === "/en");
const enStar = rules.findIndex((r) => r.from === "/en/*");
ok(enExact !== -1, "an exact /en/ rule exists");
ok(enStar === -1 || enExact < enStar,
   "the exact /en/ rule is matched before any /en/* wildcard",
   `exact at ${enExact}, wildcard at ${enStar}`);
ok(rules[enExact] && rules[enExact].to === "/index.html",
   "/en/ serves index.html directly, never '/' (which carries the forced geo redirect)",
   rules[enExact] ? rules[enExact].to : "?");

/* ---------- hreflang has to point BOTH ways ------------------------------
   A page that declares an alternate which does not declare it back is ignored
   outright — the pairing is the signal, not the tag. Until 15 Aug 2026 only the
   Russian pages carried canonical + hreflang; the English originals had none at
   all, so every declaration on the site was one-directional and search engines
   were entitled to disregard the lot. That matters most for Yandex, which is
   the search engine the /ru/ version exists to reach. */
console.log("\nhreflang pairs point both ways");
const PAIRS = [["guide.html", "ru/guide.html"],
               ["legal.html", "ru/legal.html"],
               ["delete-account.html", "ru/delete-account.html"]];
const read = (f) => { try { return fs.readFileSync(path.join(ROOT, f), "utf8"); } catch (e) { return ""; } };
const canonOf = (s) => (/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i.exec(s) || [])[1];
const altsOf = (s) => Object.fromEntries(
  [...s.matchAll(/<link[^>]+rel="alternate"[^>]+hreflang="([^"]+)"[^>]+href="([^"]+)"/gi)]
    .map((m) => [m[1], m[2]]));

for (const [en, ru] of PAIRS) {
  const E = read(en), R = read(ru);
  const eA = altsOf(E), rA = altsOf(ru ? R : "");
  ok(canonOf(E) === `https://dota2tileague.com/${en}`, `${en} self-canonicals`, canonOf(E) || "absent");
  ok(canonOf(R) === `https://dota2tileague.com/${ru}`, `${ru} self-canonicals`, canonOf(R) || "absent");
  /* Exactly one canonical. Two pointing at different URLs is worse than none,
     and it is invisible in a browser — the RU pages are generated from the EN
     ones, so adding tags to the source can silently duplicate them. */
  ok((E.match(/rel="canonical"/gi) || []).length === 1, `${en} has exactly one canonical`);
  ok((R.match(/rel="canonical"/gi) || []).length === 1, `${ru} has exactly one canonical`);
  ok(eA.ru === `https://dota2tileague.com/${ru}`, `${en} points at its Russian twin`, eA.ru || "absent");
  ok(rA.en === `https://dota2tileague.com/${en}`, `${ru} points back at its English twin`, rA.en || "absent");
  ok(eA.en === rA.en && eA.ru === rA.ru, `${en} and ${ru} agree on the pair`);
}
/* watch.html deliberately has NO Russian alternate: /ru/watch.html rewrites to
   this same English page, so declaring one would point at English content. */
const W = read("watch.html");
ok(canonOf(W) === "https://dota2tileague.com/watch.html", "watch.html self-canonicals", canonOf(W) || "absent");
ok(!altsOf(W).ru, "watch.html claims no Russian version (there isn't one)");

console.log("\nrobots and sitemap");
const robots = read("robots.txt"), sm = read("sitemap.xml");
ok(/^\s*Sitemap:\s*https:\/\/dota2tileague\.com\/sitemap\.xml\s*$/m.test(robots), "robots.txt advertises the sitemap");
ok((robots.match(/^\s*User-agent:/gim) || []).length === 1, "robots.txt has a single user-agent group",
   "a second identical group is handled inconsistently between crawlers");
ok(/^\s*Disallow:\s*\/en\/\s*$/m.test(robots), "/en/ is disallowed (it duplicates / and cannot self-canonical)");
ok(sm.startsWith("<?xml"), "sitemap.xml is XML");
const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
ok(locs.length >= 8, "sitemap lists both language versions", `${locs.length} urls`);
ok(!locs.some((l) => l.includes("/en/")), "sitemap does not list /en/ (it is disallowed)");
/* Every sitemap URL must resolve — a sitemap full of 404s is worse than none. */
for (const l of locs) {
  const p = l.replace("https://dota2tileague.com", "");
  const r = serve(p, 0);
  ok(r.okFile, `sitemap: ${p}`, r.okFile ? "" : r.why);
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nevery internal link resolves from every prefix");
process.exit(fail ? 1 : 0);
