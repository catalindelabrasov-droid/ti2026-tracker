// Notices that a TI match has started, and tells the phones that asked.
//
// Runs every couple of minutes from pg_cron. Two things can trigger a
// notification, and they answer different questions:
//
//   "soon" — a match on the published schedule is about to begin. This is the
//            one people actually want: it gives you time to open the stream.
//            It depends on Liquipedia having filled in a start time, which it
//            does closer to the event.
//
//   "live" — OpenDota's live feed shows the game actually running. This is the
//            reliable one. Esports schedules slip constantly, so "it started"
//            is worth more than "it was meant to start". It needs the TI league
//            id, which Valve only publishes days before the event, so that is
//            read from app_config rather than baked in here.
//
// Both are deduplicated through push_log, so a match is announced once no
// matter how many times this runs or how the two triggers overlap.

import webpush from "npm:web-push@3.6.7";

const SB_URL   = Deno.env.get("SUPA_URL") ?? Deno.env.get("SUPABASE_URL")!;
const SB_KEY   = Deno.env.get("SUPA_SERVICE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUB  = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIV = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUB  = Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@dota2tileague.com";
const TICK_SECRET = Deno.env.get("PUSH_TICK_SECRET") ?? "";
const SITE = "https://dota2tileague.com";

webpush.setVapidDetails(VAPID_SUB, VAPID_PUB, VAPID_PRIV);

const H = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  "Content-Type": "application/json",
};

async function sbGet(path: string) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: H });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return await r.json();
}

async function config(key: string, fallback: unknown) {
  const rows = await sbGet(`app_config?select=value&key=eq.${key}`);
  return rows.length ? rows[0].value : fallback;
}

// Claim the right to announce something. Returns false if somebody already
// has — the primary key does the arbitration, so two overlapping runs cannot
// both send.
async function claim(matchKey: string, kind: string): Promise<boolean> {
  const r = await fetch(`${SB_URL}/rest/v1/push_log`, {
    method: "POST",
    headers: { ...H, Prefer: "return=minimal" },
    body: JSON.stringify({ match_key: matchKey, kind }),
  });
  if (r.status === 409) return false;          // already claimed
  if (!r.ok) { console.error("claim failed", r.status, await r.text()); return false; }
  return true;
}

type Sub = { endpoint: string; p256dh: string; auth: string; failures: number };

async function send(subs: Sub[], payload: Record<string, unknown>) {
  const body = JSON.stringify(payload);
  let ok = 0;
  const dead: string[] = [];

  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body,
      );
      ok++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      // 404/410 mean the browser threw the subscription away — the user
      // uninstalled, cleared data, or revoked permission. Keeping it would
      // mean retrying forever.
      if (code === 404 || code === 410) dead.push(s.endpoint);
      else console.error("push failed", code, String(e).slice(0, 200));
    }
  }));

  if (dead.length) {
    const list = dead.map((e) => `"${encodeURIComponent(e)}"`).join(",");
    await fetch(`${SB_URL}/rest/v1/push_subscriptions?endpoint=in.(${list})`,
      { method: "DELETE", headers: H });
  }
  return { ok, pruned: dead.length };
}

// The schedule is rewritten once an hour by the updater, but this function
// runs every two minutes. Re-downloading 70 KB thirty times an hour to read a
// file that has not changed is 1.5 GB a month of nothing; hold it for five.
let _sched: { at: number; data: any } | null = null;
const SCHED_TTL = 5 * 60 * 1000;

// One cached copy, shared by everything that needs the schedule.
async function schedule(): Promise<any | null> {
  if (_sched && Date.now() - _sched.at < SCHED_TTL) return _sched.data;
  try {
    const r = await fetch(`${SITE}/data.json`, { headers: { "Cache-Control": "no-cache" } });
    const data = await r.json();
    _sched = { at: Date.now(), data };
    return data;
  } catch (_e) { return _sched?.data ?? null; }
}

// --- what is about to start, from the published schedule ---------------------
async function upcoming(minutes: number) {
  const out: { key: string; a: string; b: string; mins: number; bo: number }[] = [];
  const data = await schedule();
  if (!data) return out;

  const rounds: any[] = [];
  if (data?.groupStage?.rounds) rounds.push(...data.groupStage.rounds);
  if (data?.bracket?.rounds?.upper) rounds.push(...data.bracket.rounds.upper);
  if (data?.bracket?.rounds?.lower) rounds.push(...data.bracket.rounds.lower);
  const all = rounds.flatMap((r) => r?.matches ?? []);
  if (data?.bracket?.grandFinal) all.push(data.bracket.grandFinal);

  const now = Date.now();
  for (const m of all) {
    if (!m?.scheduled || m.status === "completed") continue;
    const t = Date.parse(m.scheduled);
    if (!Number.isFinite(t)) continue;
    const mins = Math.round((t - now) / 60000);
    // Only the window ahead: a match that started twenty minutes ago is not
    // "about to start", and telling somebody so is worse than silence.
    if (mins < 0 || mins > minutes) continue;
    const a = m.teamA?.name ?? "TBD", b = m.teamB?.name ?? "TBD";
    if (a === "TBD" || b === "TBD") continue;
    // The claim key carries the scheduled time, bucketed to the quarter hour.
    //
    // On opening night the schedule said 10:00 local, we announced at 01:50
    // UTC, and the times were then corrected to 11:00 — an hour later. Keyed
    // on the match id alone the claim was already spent, so nobody was told
    // when the games actually began: one false alarm, then silence. Bucketing
    // means a real reschedule earns a fresh notification while a two-minute
    // wobble does not.
    const bucket = Math.round(t / (15 * 60 * 1000));
    out.push({ key: `soon:${m.id}:${bucket}`, a, b, mins, bo: m.bestOf ?? 3 });
  }
  return out;
}

/* --- what just became predictable -------------------------------------------
   A fixture is worth predicting the moment BOTH teams are known. During a Swiss
   round the next pairings are drawn minutes after the previous games end, and
   the lock deadline is half an hour before kick-off — so somebody who is not
   staring at the page misses the window entirely. That is the notification this
   sends: not "a match is starting", but "you can still pick this one".

   Keyed on the id AND the pairing, so a fixture that was TBD announces once when
   the draw lands, and a corrected pairing announces again rather than being
   silently swallowed by the earlier claim. */
async function newlyPredictable(lockLeadMin: number) {
  const out: { key: string; a: string; b: string }[] = [];
  const data = await schedule();
  if (!data) return out;

  const rounds: any[] = [];
  if (data?.groupStage?.rounds) rounds.push(...data.groupStage.rounds);
  if (data?.bracket?.rounds?.upper) rounds.push(...data.bracket.rounds.upper);
  if (data?.bracket?.rounds?.lower) rounds.push(...data.bracket.rounds.lower);
  const all = rounds.flatMap((r) => r?.matches ?? []);
  if (data?.bracket?.grandFinal) all.push(data.bracket.grandFinal);

  const now = Date.now();
  for (const m of all) {
    if (!m?.id || m.status === "completed") continue;
    const a = String(m.teamA?.name ?? "").trim();
    const b = String(m.teamB?.name ?? "").trim();
    if (!a || !b || a === "TBD" || b === "TBD") continue;
    // Already locked or under way: telling someone to pick it now is a lie.
    if (m.scheduled) {
      const t = Date.parse(m.scheduled);
      if (Number.isFinite(t) && t - now <= lockLeadMin * 60000) continue;
    } else if (m.status === "live") continue;
    out.push({ key: `predict:${m.id}:${[a, b].sort().join("|")}`, a, b });
  }
  return out;
}

// --- what is actually running, from OpenDota ---------------------------------
async function liveNow(leagueIds: number[]) {
  const out: { key: string; a: string; b: string }[] = [];
  if (!leagueIds.length) return out;
  let games: any[] = [];
  try {
    const r = await fetch("https://api.opendota.com/api/live", {
      headers: { "User-Agent": "dota2tileague/1.0" },
    });
    games = await r.json();
  } catch (_e) { return out; }
  if (!Array.isArray(games)) return out;

  const nowSec = Math.floor(Date.now() / 1000);
  const seen = new Set<string>();
  for (const g of games) {
    if (!leagueIds.includes(Number(g?.league_id))) continue;
    if (g.deactivate_time) continue;                       // already over
    const age = nowSec - (g.last_update_time || 0);
    if (!g.last_update_time || age > 25 * 60) continue;     // feed went quiet
    // Trim: the feed returns "Nigma Galaxy " with a trailing space, and an
    // untrimmed name in the claim key means the same series is announced twice
    // the day the feed cleans it up.
    const a = String(g.team_name_radiant ?? "").trim();
    const b = String(g.team_name_dire ?? "").trim();
    if (!a || !b) continue;
    // The live feed repeats the same series under different match ids; one
    // notification per pairing is the useful behaviour.
    const key = `live:${g.league_id}:${[a, b].sort().join("|")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, a, b });
  }
  return out;
}

Deno.serve(async (req) => {
  // Only the scheduler may pull this trigger — it sends to every device.
  if (TICK_SECRET && req.headers.get("x-tick-secret") !== TICK_SECRET) {
    return new Response("no", { status: 401 });
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dry") === "1";

  try {
    const subs: Sub[] = await sbGet(
      "push_subscriptions?select=endpoint,p256dh,auth,failures&topics=cs.{ti}&limit=5000");

    // A test push, so the pipeline can be proven before TI exists.
    if (url.searchParams.get("test") === "1") {
      const res = await send(subs, {
        title: "TI League — test",
        body: "Notifications are working. You'll get one when a TI match starts.",
        url: "/",
        tag: "test",
      });
      return Response.json({ mode: "test", subs: subs.length, ...res });
    }

    // Nobody to tell: don't fetch a 70 KB schedule and poll OpenDota every few
    // minutes for the sake of it. This runs all year; TI does not.
    if (!subs.length) return Response.json({ subs: 0, idle: true });

    const soonMins = Number(await config("push_soon_minutes", 10)) || 10;
    const leagues: number[] = (await config("ti_league_ids", [])).map(Number).filter(Boolean);

    // A TI round starts four matches at the same minute. Announcing each one
    // separately means four buzzes at five in the morning, which is how people
    // learn to turn notifications off for good. So: claim each match on its
    // own — that is what keeps "announce once" honest — but send ONE
    // notification per tick per kind, listing whatever was claimed.
    const jobs: { key: string; kind: string; line: string; mins?: number }[] = [];

    for (const m of await upcoming(soonMins)) {
      jobs.push({ key: m.key, kind: "soon", line: `${m.a} vs ${m.b}`, mins: m.mins });
    }
    for (const m of await liveNow(leagues)) {
      jobs.push({ key: m.key, kind: "live", line: `${m.a} vs ${m.b}` });
    }
    const lockLead = Number(await config("push_predict_lock_lead_min", 30)) || 30;
    for (const m of await newlyPredictable(lockLead)) {
      jobs.push({ key: m.key, kind: "predict", line: `${m.a} vs ${m.b}` });
    }

    if (dryRun) return Response.json({ dryRun: true, subs: subs.length, leagues, jobs });

    const fresh: typeof jobs = [];
    for (const j of jobs) if (await claim(j.key, j.kind)) fresh.push(j);

    // Three fixtures is as much as a notification can show before the phone
    // truncates it; the rest become "+2 more".
    const summarise = (lines: string[]) =>
      lines.length <= 3 ? lines.join(" · ")
                        : `${lines.slice(0, 3).join(" · ")} +${lines.length - 3} more`;

    let sent = 0;
    const announced: string[] = [];
    for (const kind of ["predict", "soon", "live"]) {
      const group = fresh.filter((j) => j.kind === kind);
      if (!group.length) continue;

      const mins = Math.min(...group.map((j) => j.mins ?? 0));
      const title = kind === "live"
        ? (group.length > 1 ? `${group.length} TI matches are live` : "Live now")
        : kind === "predict"
        ? (group.length > 1 ? `${group.length} new matches to predict` : "New match to predict")
        : (mins <= 1 ? "TI is starting" : `TI starts in ${mins} min`);

      const res = await send(subs, {
        title,
        body: kind === "predict"
          ? `${summarise(group.map((j) => j.line))} — lock your picks before they start.`
          : summarise(group.map((j) => j.line)),
        // Straight to the predict tab: a notification that drops you on the
        // home page and leaves you to find the picks yourself is a wasted buzz.
        url: kind === "predict" ? "/#predict" : "/",
        // One tag per kind per burst, so a later round replaces the last
        // rather than stacking up behind it.
        tag: `ti-${kind}`,
      });
      for (const j of group) {
        await fetch(
          `${SB_URL}/rest/v1/push_log?match_key=eq.${encodeURIComponent(j.key)}&kind=eq.${j.kind}`,
          { method: "PATCH", headers: { ...H, Prefer: "return=minimal" },
            body: JSON.stringify({ sent_to: res.ok }) });
        announced.push(j.key);
      }
      sent += res.ok;
    }
    return Response.json({ subs: subs.length, announced, sent });
  } catch (e) {
    console.error(e);
    return Response.json({ error: String(e) }, { status: 500 });
  }
});
