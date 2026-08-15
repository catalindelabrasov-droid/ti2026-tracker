/* Guard the redirect rules against the trailing-slash trap.
 *
 * Run: node tools/test_redirects.js       (no dependencies)
 *
 * WHY THIS EXISTS
 *
 * A first draft of netlify.toml had, in this order:
 *
 *     [[redirects]] from = "/ru"   to = "/ru/"        status = 301
 *     [[redirects]] from = "/ru/"  to = "/index.html" status = 200
 *
 * which reads as obviously correct and is not. Netlify's matcher ignores the
 * trailing slash, so the FIRST rule also matches "/ru/", and rules are
 * first-match-wins — "/ru/" redirected to itself forever. The Russian site was
 * 100% unreachable with ERR_TOO_MANY_REDIRECTS, and the second rule was dead
 * code. Confirmed against `netlify dev` before and after the fix.
 *
 * The bug lives in the matcher's semantics, not in the text, so a plain reading
 * of the file will never catch it. What this encodes instead is the invariant:
 * compare every rule by its slash-insensitive path, the way Netlify does.
 */
const fs = require("fs");
const path = require("path");

/* Comments are stripped BEFORE parsing. This file documents the trailing-slash
   trap and the force=true requirement in prose, and a comment sitting between
   two blocks is otherwise read as part of the earlier one — which made /en/
   look force-conditioned because the paragraph above the geo rule says
   "force = true is REQUIRED". */
const toml = fs.readFileSync(path.join(__dirname, "..", "netlify.toml"), "utf8")
  .split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

const rules = [];
for (const chunk of toml.split("[[redirects]]").slice(1)) {
  const stop = chunk.search(/^\s*\[\[/m);
  const b = stop === -1 ? chunk : chunk.slice(0, stop);
  const str = (k) => (new RegExp(k + '\\s*=\\s*"([^"]+)"').exec(b) || [])[1];
  if (!str("from")) continue;
  rules.push({
    from: str("from"),
    to: str("to"),
    status: Number((/status\s*=\s*(\d+)/.exec(b) || [])[1] || 301),
    force: /force\s*=\s*true/.test(b),
    /* Country conditions gate the geo redirect; an unparsed condition would
       make a forced rule look unconditional. */
    country: ((/Country\s*=\s*\[([^\]]*)\]/.exec(b) || [])[1] || "")
      .split(",").map((x) => x.replace(/[^A-Za-z]/g, "").toUpperCase()).filter(Boolean),
  });
}

/* How Netlify compares paths: trailing slash is not significant. */
const key = (p) => (p || "").replace(/\/+$/, "") || "/";

let fail = 0;
const ok = (c, m, x) => { console.log((c ? "  ok   " : "  FAIL ") + m + (x ? "   " + x : "")); if (!c) fail++; };

console.log(`${rules.length} redirect rules\n`);

// 1. THE bug: a redirect whose destination is its own source once slashes are ignored.
for (const r of rules) {
  const selfish = r.status >= 300 && r.status < 400 && key(r.from) === key(r.to);
  ok(!selfish, `${r.from} -> ${r.to} (${r.status}) is not a self-redirect`,
     selfish ? "INFINITE LOOP" : "");
}

// 2. First-match-wins: no earlier rule may swallow a later one's path.
for (let i = 0; i < rules.length; i++) {
  for (let j = i + 1; j < rules.length; j++) {
    const shadowed = key(rules[i].from) === key(rules[j].from);
    ok(!shadowed, `rule ${j + 1} (${rules[j].from}) is reachable`,
       shadowed ? `shadowed by rule ${i + 1} (${rules[i].from})` : "");
  }
}

// 3. A 3xx must not point at a path that another 3xx sends back — a two-hop loop.
for (const a of rules.filter((r) => r.status >= 300 && r.status < 400)) {
  const back = rules.find((b) => b.status >= 300 && b.status < 400 &&
    key(b.from) === key(a.to) && key(b.to) === key(a.from));
  ok(!back, `${a.from} -> ${a.to} has no return rule`, back ? "TWO-HOP LOOP" : "");
}

// 4. English routes must not be captured, slashes ignored.
const ENGLISH = ["/index.html", "/guide.html", "/legal.html", "/watch.html",
                 "/delete-account.html", "/data.json", "/sw.js", "/manifest.webmanifest"];
for (const p of ENGLISH) {
  const hit = rules.find((r) => key(r.from) === key(p));
  ok(!hit, `${p} is untouched by the redirect rules`, hit ? `caught by ${hit.from}` : "");
}
/* "/" is deliberately caught now — but ONLY by a country-conditioned rule, so
   a visitor from anywhere else still gets the English homepage. */
for (const r of rules.filter((x) => key(x.from) === "/")) {
  ok(r.country.length > 0, `the rule on "/" is country-conditioned`,
     r.country.length ? "" : "it would redirect EVERYONE to /ru/");
}

/* 5. force = true is allowed ONLY on the geo redirect.
      "/" has a real index.html behind it and Netlify prefers a real file, so
      the geo rule cannot fire without force. Anywhere else, force would let a
      rule shadow a real file — which is exactly what must not happen to the
      Russian prose pages under ru/. */
for (const r of rules) {
  if (!r.force) continue;
  ok(r.country.length > 0, `${r.from} is forced but has no Country condition`);
  ok(r.from === "/", `only "/" may be force-redirected, not ${r.from}`);
  ok(r.status === 302, `${r.from} geo redirect must be 302, not ${r.status}`,
     "a 301 is cached forever and traps the reader");
}

/* 6. The English escape hatch must exist and must never be geo-redirected,
      or the "English" link on /ru/ bounces straight back. */
const en = rules.find((r) => key(r.from) === "/en");
ok(!!en, "/en/ escape hatch exists");
ok(!en || !en.country.length, "/en/ carries no Country condition");
ok(!en || en.status === 200, "/en/ is a rewrite, not a redirect", en ? String(en.status) : "");

/* 7. Countries that are politically fraught for a Russian-language default
      must be an explicit decision, not an accident. */
const geo = rules.find((r) => r.country.length);
if (geo) {
  ok(!geo.country.includes("UA"), "UA is not auto-routed to the Russian version");
  console.log(`         (geo: ${geo.country.join(", ")})`);
}

// 6. Every /ru rewrite must land on a file that exists.
for (const r of rules.filter((x) => x.status === 200)) {
  const target = path.join(__dirname, "..", r.to.replace(/^\//, ""));
  ok(fs.existsSync(target), `${r.from} -> ${r.to} target exists`);
}

console.log(fail ? `\n${fail} CHECK(S) FAILED` : "\nall checks pass");
process.exit(fail ? 1 : 0);
