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

// --- what is about to start, from the published schedule ---------------------
async function upcoming(minutes: number) {
  const out: { key: string; a: string; b: string; mins: number; bo: number }[] = [];
  let data: any;
  try {
    const r = await fetch(`${SITE}/data.json`, { headers: { "Cache-Control": "no-cache" } });
    data = await r.json();
  } catch (_e) { return out; }

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
    out.push({ key: `soon:${m.id}`, a, b, mins, bo: m.bestOf ?? 3 });
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
    const a = g.team_name_radiant, b = g.team_name_dire;
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

    const jobs: { key: string; title: string; body: string }[] = [];

    for (const m of await upcoming(soonMins)) {
      jobs.push({
        key: m.key,
        title: "TI starts soon",
        body: m.mins <= 1 ? `${m.a} vs ${m.b} is about to start · Bo${m.bo}`
                          : `${m.a} vs ${m.b} in ${m.mins} min · Bo${m.bo}`,
      });
    }
    for (const m of await liveNow(leagues)) {
      jobs.push({ key: m.key, title: "Live now", body: `${m.a} vs ${m.b} has started` });
    }

    if (dryRun) return Response.json({ dryRun: true, subs: subs.length, leagues, jobs });

    let sent = 0;
    const done: string[] = [];
    for (const j of jobs) {
      const [kind] = j.key.split(":");
      if (!await claim(j.key, kind)) continue;
      const res = await send(subs, { title: j.title, body: j.body, url: "/", tag: j.key });
      await fetch(`${SB_URL}/rest/v1/push_log?match_key=eq.${encodeURIComponent(j.key)}&kind=eq.${kind}`,
        { method: "PATCH", headers: { ...H, Prefer: "return=minimal" },
          body: JSON.stringify({ sent_to: res.ok }) });
      sent += res.ok;
      done.push(j.key);
    }
    return Response.json({ subs: subs.length, announced: done, sent });
  } catch (e) {
    console.error(e);
    return Response.json({ error: String(e) }, { status: 500 });
  }
});
