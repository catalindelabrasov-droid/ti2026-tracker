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
  const timer = setTimeout(() => ac.abort(), opts.timeout || TIMEOUT_MS);
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

/* The bracket predicate, lifted out of the run so a test can drive THIS code
   rather than a copy of it. tools/test_bracket_assertion.js runs it over the
   real 16 Aug fabrication pulled from git and over ten synthetic states; a
   lifted copy would have proved only that the copy works. */
const NO_WRITER_GRACE_H = 6;   /* the wider of the two update_data.py bounds */
const SLACK_H = 1 / 6;         /* 10 min, for clock skew between us and the CDN */

function collectBracketFixtures(data) {
  const brr = ((data || {}).bracket || {}).rounds || {};
  const out = [];
  [...(brr.upper || []), ...(brr.lower || [])].forEach((rd) =>
    (rd.matches || []).forEach((m) => out.push(m)));
  if (((data || {}).bracket || {}).grandFinal) out.push(data.bracket.grandFinal);
  (((data || {}).groupStage || {}).eliminationMatches || []).forEach((m) => out.push(m));
  return out;
}

function bracketVerdict(data, nowMs) {
  const all = collectBracketFixtures(data);
  const judged = [], earlyAll = [], beyondGrace = [], lateStart = [], stuckLive = [];
  for (const m of all) {
    const start = Date.parse(m.scheduled || "");

    /* THE OTHER DIRECTION: a fixture that is LATE.
     *
     * Everything above this asks whether a result arrived too EARLY, because
     * that is how the bracket was fabricated on 16 Aug. It says nothing about
     * the failure that actually reached users: on 20 Aug me-r1m2 had been
     * being played for 28 minutes and the site still read "upcoming", because
     * the quarter-hourly pass wrote status to the database but never rewrote
     * data.json. Production reported healthy throughout.
     *
     * A fixture whose own published kick-off has passed while it still reads
     * upcoming is either not being published or genuinely delayed - and
     * Liquipedia has moved the published time within the hour both times a
     * match slipped today (10:00->10:30, 13:00->13:30), so a stale time is the
     * less likely of the two. Either way it is worth a look.
     *
     * 45 minutes: three quarter-hour passes. With status now publishing on the
     * fast pass the honest lag is one cycle, so this fires only when something
     * is genuinely stuck rather than merely between runs. */
    if (m.status === "upcoming" && Number.isFinite(start)) {
      const lateMin = (nowMs - start) / 60000;
      if (lateMin > 45) {
        lateStart.push(`${m.id} kicked off ${Math.round(lateMin)} min ago `
          + `but still reads upcoming`);
      }
    }

    /* And a fixture that never stops. The existing stuck-live check walks
       groupStage.rounds only, which from 20 Aug contains nothing being played -
       every real match is in data.bracket. A Dota series runs 1-3 hours; six is
       not a long game, it is a status that stopped moving. */
    if (m.status === "live" && Number.isFinite(start)) {
      const hrs = (nowMs - start) / 3600000;
      if (hrs > 6) stuckLive.push(`${m.id} has been live for ${hrs.toFixed(1)}h`);
    }

    if (m.status !== "completed" && m.status !== "live") continue;
    if (!Number.isFinite(start)) continue;        /* no date: nothing to judge */
    judged.push(m.id);
    const ahead = (start - nowMs) / 3600000;
    if (ahead <= SLACK_H) continue;
    const line = `${m.id} reported ${m.status} `
      + `${(m.teamA || {}).score}-${(m.teamB || {}).score} but starts in ${ahead.toFixed(1)}h`;
    earlyAll.push(line);
    if (ahead > NO_WRITER_GRACE_H) beyondGrace.push(line);
  }
  return { total: all.length, judged, earlyAll, beyondGrace, lateStart, stuckLive };
}

const main = async () => {
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
    /* MUST EXCEED THE FULL-RUN INTERVAL, or this fails on a healthy site.
       It was 60, on the premise "the updater runs every 15 minutes". That
       premise is wrong twice over. Only the HOURLY full run writes data.json;
       the :15/:30/:45 fast passes write match_results in Supabase and never
       touch it. And this job runs seconds after the commit - measured 19 Aug,
       the data commit landed at 07:01:01 and verify-production started at
       07:01:07 - so production is still serving the PREVIOUS hour's file,
       aged exactly 60 minutes, while Netlify builds. `age < 60` was therefore
       false on every single :00 run: a red build and a failure email once an
       hour, on a site that was completely healthy.

       That is not a cosmetic problem. On 17 Aug this same alarm was firing
       correctly - the site had frozen for six hours because Netlify credit ran
       out - and it was read as noise, because it had been noise all week.

       75 = the hourly interval plus a 15-minute margin for the build, which is
       the same number and the same reasoning as STALE_MIN in
       supabase/functions/updater-watchdog. tools/test_watchdog_cadence.js
       asserts the two agree; change them together or not at all. */
    const MAX_DATA_AGE_MIN = 75;
    ok(Number.isFinite(age) && age < MAX_DATA_AGE_MIN,
       `data.json is fresher than ${MAX_DATA_AGE_MIN} min`,
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

    /* A RESULT BEFORE ITS OWN KICKOFF.
     *
     * On 16 Aug the whole playoff bracket arrived as finished, four days
     * early. It landed in `data.bracket`, which this file walked only for team
     * names and never once status-checked. Nothing in the repo can see this
     * either: it is a property of what production is serving right now.
     *
     * TWO RULES, because "decided before kickoff" is NOT by itself a fault.
     * Both writers deliberately allow it - _build_match up to an hour ahead,
     * merge_opendota_scores up to six - because a Bo3 that ends 2-0 in seventy
     * minutes frees the stage and the next series starts early, and the
     * published schedule is then stale rather than wrong. A single assertion
     * at ten minutes would have called that correct data a failure and gone
     * red every fifteen minutes until the clock caught up - up to twenty-four
     * consecutive red builds on one legitimate early finish. This file's own
     * comment above says why that is the worst outcome available: a red build
     * nobody trusts is how a real failure gets missed.
     *
     * So the two rules fire on what a legitimate early settle CANNOT look
     * like:
     *
     *   1. Beyond six hours, no writer in update_data.py will produce it at
     *      all. Both refuse first. Data in that state did not come through
     *      either guard - which is exactly the shape of 16 Aug, where the
     *      grand final was decided 143 hours out.
     *
     *   2. In bulk. An early settle is one series at a time, and the stage
     *      only frees up once. Across 627 data.json revisions no genuine
     *      update ever decided more than three fixtures at once; the
     *      fabrication decided fourteen simultaneously.
     *
     * A lone fixture settled inside the writers' own grace is printed as a
     * note and does not fail the build. That is the false-red this pair is
     * shaped to avoid.
     *
     * KNOWN BLIND SPOT, stated so the green line is not read as more than it
     * is: once a match has legitimately kicked off, the clock has nothing left
     * to say and neither rule can see anything. Per-fixture, real coverage
     * runs from six hours before kickoff to ten minutes before it, and stops
     * there. A fabricated result arriving mid-series is invisible here, and
     * refuting it needs OpenDota game-row corroboration, which lives in the
     * updater, not in this file.
     */
    const { total, judged, earlyAll, beyondGrace, lateStart, stuckLive } =
      bracketVerdict(data, Date.now());
    ok(beyondGrace.length === 0,
       "no playoff fixture is decided beyond what either writer can produce",
       beyondGrace.join("; "));
    ok(earlyAll.length < 2,
       "playoff fixtures are not being decided before kickoff in bulk",
       earlyAll.length < 2 ? "" : `${earlyAll.length} at once: ` + earlyAll.join("; "));
    ok(lateStart.length === 0,
       "no playoff fixture has kicked off while the site still says upcoming",
       lateStart.join("; "));
    ok(stuckLive.length === 0,
       "no playoff fixture is stuck in live",
       stuckLive.join("; "));
    if (earlyAll.length === 1 && !beyondGrace.length && !QUIET) {
      console.log("  note   a single early settle, inside the writers' grace: " + earlyAll[0]);
    }
    /* Judged, not counted. The array length is not evidence: every bracket
       fixture is 'upcoming' until it plays, so before the playoffs start this
       pair legitimately judges almost nothing, and printing 19 would read as
       19 things verified. */
    if (!QUIET) {
      console.log(`         (${judged.length} of ${total} bracket fixtures `
        + `had a decided status and a readable date to judge)`);
    }
  }

  /* ---- 4. the edge functions the page depends on ------------------------- */
  /* live-matches fans out to OpenDota and Valve, so its latency is not its
     own. On 19 Aug 2026 OpenDota went down - HTTP 522 from its edge, ~19 s to
     fail - and this function still answered 200 with empty arrays after 25
     seconds, degrading exactly as intended. The default 15 s budget turned
     that into "HTTP 0" three times over and a red build every fifteen minutes
     for the length of the outage. A third-party outage is worth SEEING, but it
     is not this site being down, and it must not be what the alarm is shouting
     the day before the playoffs. 30 s, with the latency printed either way. */
  console.log("\nthe live feed responds");
  const t0 = Date.now();
  const feed = await get(FN + "/live-matches", { timeout: 30000 });
  const feedSec = ((Date.now() - t0) / 1000).toFixed(1);
  ok(feed.status === 200, "live-matches answers",
     feed.status === 200 ? `${feedSec}s` : `HTTP ${feed.status} after ${feedSec}s`);
  /* Slow is a note, not a failure - and it names the likely cause so nobody has
     to rediscover it at two in the morning. */
  if (feed.status === 200 && Number(feedSec) > 10 && !QUIET) {
    console.log(`  note   ${feedSec}s is slow here - it fans out to OpenDota, check that first`);
  }

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
};

/* Only run when invoked directly. `require`ing this file must not fire 45
   network requests at production or call process.exit - that is what lets the
   test drive the real predicate. */
if (require.main === module) main();

module.exports = { bracketVerdict, collectBracketFixtures, NO_WRITER_GRACE_H, SLACK_H };
