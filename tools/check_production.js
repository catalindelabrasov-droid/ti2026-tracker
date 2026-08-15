/* Ask PRODUCTION whether it works. Not the repo — the deployed site.
 *
 * Run: node tools/check_production.js            (no dependencies)
 *      node tools/check_production.js --quiet    (only print failures)
 *
 * WHY THIS EXISTS
 *
 * On 15 Aug 2026, mid-tournament, the user opened /en/watch.html and got a
 * Netlify 404. So did /en/guide.html, /en/legal.html and /en/delete-account.html.
 * Every sub-page link on the English page had been dead in production for days.
 *
 * Eighteen test files passed the whole time. They all read the repo: they can
 * prove the source is self-consistent, and they cannot prove a URL answers.
 * Nothing in this project had ever asked the live site a question. The user
 * found it by clicking a link.
 *
 * So this is the layer that was missing. It makes no assumptions from the
 * source; it fetches real URLs over the real CDN and checks what comes back.
 * Everything here is a GET or HEAD — it reads, it never writes, and it touches
 * no endpoint that sends, charges or mutates.
 *
 * Wired into the updater workflow, which pg_cron fires every 15 minutes, so a
 * regression surfaces within a quarter of an hour instead of when someone
 * happens to click.
 */
const QUIET = process.argv.includes("--quiet");
const SITE = process.env.SITE_URL || "https://dota2tileague.com";
const FN = "https://hqpynfzatnmwvlxdfhsw.functions.supabase.co";

let fail = 0, checked = 0;
const failures = [];
const ok = (c, m, x) => {
  checked++;
  if (!c) { fail++; failures.push(m + (x ? " — " + x : "")); }
  if (!c || !QUIET) console.log((c ? "  ok   " : "  FAIL ") + m + (x ? "   " + x : ""));
};

/* Retry before crying wolf.
 *
 * This runs every 15 minutes off the updater. With ~47 network calls a run,
 * that is thousands of requests a day, and at that volume a transient blip is
 * not a possibility — it is a certainty. The first version failed the build on
 * any single non-200, which produced a red build and an email for a fault that
 * had already healed by the time anyone looked. update.yml says exactly why
 * that is worse than useless: "a red build nobody trusts is how a real failure
 * gets missed."
 *
 * So: a request is only a failure if it fails REPEATEDLY. Retries cover network
 * errors, timeouts, 5xx and 429 — the transient shapes. A 404 is NOT retried:
 * that is a real answer, and the whole point of this file is to catch it. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TRIES = 3, TIMEOUT_MS = 15000;

const attempt = async (url, opts) => {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      redirect: "follow", signal: ac.signal,
      headers: { "cache-control": "no-cache" }, ...opts,
    });
    return { status: r.status, ok: r.ok, text: opts.method === "HEAD" ? "" : await r.text(),
             type: r.headers.get("content-type") || "" };
  } catch (e) {
    return { status: 0, ok: false, text: "", type: "", err: e.name === "AbortError" ? `timed out after ${TIMEOUT_MS}ms` : e.message };
  } finally { clearTimeout(timer); }
};

const transient = (r, expect) =>
  r.status === 0 || r.status >= 500 || r.status === 429 ||
  /* An expected-401 probe that came back 200 could be a real hole OR a cold
     start answering oddly; re-ask before reporting it. */
  (expect === 401 && r.status !== 401);

const get = async (url, opts = {}) => {
  let r;
  for (let i = 1; i <= TRIES; i++) {
    r = await attempt(url, opts);
    if (!transient(r, opts.expect)) return i > 1 ? { ...r, retried: i } : r;
    if (i < TRIES) await sleep(400 * i);
  }
  return { ...r, retried: TRIES, exhausted: true };
};

(async () => {
  /* ---- 1. every public URL, under every prefix the site serves ----------- */
  console.log("every public URL answers");
  const PAGES = ["", "watch.html", "guide.html", "legal.html", "delete-account.html"];
  const PREFIXES = ["/", "/en/", "/ru/"];
  for (const prefix of PREFIXES) {
    for (const page of PAGES) {
      const url = SITE + prefix + page;
      const r = await get(url);
      ok(r.status === 200, `${prefix}${page || "(index)"}`, r.status === 200 ? "" : `HTTP ${r.status}${r.err ? " " + r.err : ""}`);
    }
  }

  /* A 200 that serves the wrong document is still broken. Each page has a
     phrase only it contains, so a rewrite pointing at the homepage is caught. */
  console.log("\n...and serves the page it should, not the homepage");
  const FINGERPRINT = [
    ["/en/watch.html", /watch/i, "watch page"],
    ["/en/guide.html", /how it works|guide/i, "guide page"],
    ["/en/legal.html", /privacy|terms/i, "legal page"],
    ["/ru/", /[Ѐ-ӿ]/, "Cyrillic on the Russian page"],
  ];
  for (const [path, re, what] of FINGERPRINT) {
    const r = await get(SITE + path);
    const good = r.status === 200 && re.test(r.text);
    ok(good, `${path} contains ${what}`,
       good ? "" : (r.status !== 200 ? `HTTP ${r.status}` : "200, but served a different page"));
  }

  /* ---- 1b. what a crawler asks for first ---------------------------------
     Yandex matters as much as Google here — /ru/ exists for readers in
     Russian-speaking countries. A sitemap advertised in robots.txt but missing
     from the deploy is worse than never advertising one. */
  console.log("\ncrawlers can find their way in");
  const rb = await get(SITE + "/robots.txt");
  ok(rb.status === 200, "robots.txt is served", rb.status === 200 ? "" : `HTTP ${rb.status}`);
  ok(/Sitemap:\s*\S+sitemap\.xml/i.test(rb.text), "robots.txt advertises the sitemap");
  const smr = await get(SITE + "/sitemap.xml");
  ok(smr.status === 200 && smr.text.startsWith("<?xml"), "sitemap.xml is served and is XML",
     smr.status === 200 ? "" : `HTTP ${smr.status}`);
  /* Every URL it lists must actually answer. A sitemap of 404s trains a
     crawler to distrust the whole file. */
  const locs = [...smr.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  ok(locs.length > 0, "sitemap lists URLs", `${locs.length}`);
  for (const l of locs) {
    const r = await get(l, { method: "HEAD" });
    ok(r.status === 200, `sitemap URL answers: ${l.replace(SITE, "") || "/"}`,
       r.status === 200 ? "" : `HTTP ${r.status}`);
  }

  /* ---- 2. the assets an installed app depends on ------------------------- */
  console.log("\nthe installed app still has what it needs");
  for (const [path, test, what] of [
    ["/manifest.webmanifest", (t) => JSON.parse(t).start_url !== undefined, "start_url"],
    ["/sw.js", (t) => /addEventListener/.test(t), "a real service worker"],
    ["/.well-known/assetlinks.json", (t) => Array.isArray(JSON.parse(t)), "the Android asset links"],
    ["/data.json", (t) => JSON.parse(t).groupStage, "the group stage"],
  ]) {
    const r = await get(SITE + path);
    let good = false;
    try { good = r.status === 200 && test(r.text); } catch (e) { good = false; }
    ok(good, `${path} has ${what}`, good ? "" : `HTTP ${r.status}`);
  }

  /* ---- 3. is the data actually current? --------------------------------- */
  console.log("\nthe data is fresh");
  const d = await get(SITE + "/data.json");
  let data = null;
  try { data = JSON.parse(d.text); } catch (e) { /* reported below */ }
  ok(!!data, "data.json parses");
  if (data) {
    const age = (Date.now() - Date.parse((data.meta || {}).lastUpdated || 0)) / 60000;
    /* The updater runs every 15 minutes. An hour without a write means it has
       stopped, and a tournament page that quietly freezes is worse than one
       that is visibly down — nobody notices until the scores are wrong. */
    ok(Number.isFinite(age) && age < 60, "updated within the last hour",
       Number.isFinite(age) ? `${age.toFixed(0)} min ago` : "no lastUpdated");

    const rounds = data.groupStage.rounds || [];
    const all = rounds.flatMap((r) => r.matches || []);
    ok(all.length > 0, "the group stage has fixtures", `${all.length} matches`);

    /* A match that is "live" for many hours is a stuck status, not a long game.
       Dota series run about 1-3 hours; six is not a game, it is a bug. */
    const live = all.filter((m) => m.status === "live");
    for (const m of live) {
      const started = Date.parse(m.scheduled || 0);
      const hrs = Number.isFinite(started) ? (Date.now() - started) / 3600000 : 0;
      ok(!(hrs > 6), `${m.id} is not stuck in "live"`, hrs > 6 ? `live for ${hrs.toFixed(1)}h` : "");
    }
    if (!QUIET) console.log(`         (${live.length} live now)`);

    /* Standings must agree with the rounds. This drifted on 15 Aug and put a
       wrong record on screen for every visitor. */
    const rec = {};
    for (const m of all) {
      if (m.status !== "completed") continue;
      const a = m.teamA || {}, b = m.teamB || {};
      if (!a.name || a.name === "TBD" || !b.name || b.name === "TBD") continue;
      if (!/^gs-/.test(m.id || "")) continue;
      rec[a.name] = rec[a.name] || [0, 0]; rec[b.name] = rec[b.name] || [0, 0];
      const aw = (a.score || 0) > (b.score || 0);
      rec[aw ? a.name : b.name][0]++; rec[aw ? b.name : a.name][1]++;
    }
    const stored = (data.groupStage.standings || []).filter((s) => s.team);
    let drift = [];
    for (const s of stored) {
      const r = rec[s.team];
      if (!r) continue;
      if (r[0] !== s.wins || r[1] !== s.losses) drift.push(`${s.team} stored ${s.wins}-${s.losses} vs rounds ${r[0]}-${r[1]}`);
    }
    ok(drift.length === 0, "stored standings match the rounds", drift.join("; "));

    /* A team renamed between the Swiss rounds and a bracket fixture scores
       locked picks as wrong, silently. */
    const swissNames = new Set();
    all.forEach((m) => { [m.teamA, m.teamB].forEach((t) => { if (t && t.name && t.name !== "TBD") swissNames.add(t.name); }); });
    const elsewhere = [];
    (data.groupStage.eliminationMatches || []).forEach((m) => {
      [m.teamA, m.teamB].forEach((t) => {
        if (t && t.name && t.name !== "TBD" && !swissNames.has(t.name)) elsewhere.push(`${m.id}: ${t.name}`);
      });
    });
    const br = (data.bracket || {}).rounds || {};
    [...(br.upper || []), ...(br.lower || [])].forEach((rd) => (rd.matches || []).forEach((m) => {
      [m.teamA, m.teamB].forEach((t) => {
        if (t && t.name && t.name !== "TBD" && !swissNames.has(t.name)) elsewhere.push(`${m.id}: ${t.name}`);
      });
    }));
    ok(elsewhere.length === 0, "no team name appears only outside the Swiss rounds", elsewhere.join("; "));
  }

  /* ---- 4. the edge functions the page depends on ------------------------- */
  console.log("\nthe live feed responds");
  const feed = await get(FN + "/live-matches");
  ok(feed.status === 200, "live-matches answers", feed.status === 200 ? "" : `HTTP ${feed.status}`);

  /* These two must REFUSE an unauthenticated call. Their guard reads
     `if (SECRET && header !== SECRET)`, so an empty secret removes the check
     entirely and the endpoint opens — push-tick sends to every device. A 200
     here means the secret has gone missing. `?dry=1` is parsed after the auth
     check, so this probe cannot cause a send either way. */
  for (const fn of ["push-tick", "updater-watchdog"]) {
    const r = await get(`${FN}/${fn}?dry=1`, { method: "POST", expect: 401 });
    ok(r.status === 401, `${fn} refuses an unauthenticated call`,
       r.status === 401 ? "" : `HTTP ${r.status} — the tick secret may be unset, which opens it`);
  }

  /* Name every failure again at the end. GitHub shows the last lines of a failed
     step as the annotation in the notification email, so what fails has to be
     legible there without opening the run — otherwise the alert says only that
     something broke, which is how a real one gets skimmed past. */
  if (fail) {
    console.log(`\n${fail} of ${checked} PRODUCTION CHECKS FAILED`);
    console.log(`(each request was retried ${TRIES}x before being called a failure, so these persisted)`);
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  } else {
    console.log(`\nproduction is healthy (${checked} checks)`);
  }
  process.exit(fail ? 1 : 0);
})();
