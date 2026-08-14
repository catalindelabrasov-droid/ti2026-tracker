// Restarts the data updater when GitHub forgets to.
//
// The results updater is a GitHub Action on an hourly cron. GitHub does not
// guarantee scheduled runs: on a public repo they are deprioritised under load
// and can be delayed or dropped entirely. On the first night of TI it skipped
// two consecutive hours and data.json went 2h15m stale while matches were
// being played — nobody would have noticed until a finished series failed to
// appear.
//
// So something has to watch. Supabase's cron is the reliable one here (30 runs
// an hour, no failures), so it checks how old the published data is and pokes
// the workflow when it has drifted. Belt and braces: the Action keeps its own
// schedule, and this only ever fires when that schedule has already failed.

const SITE = "https://dota2tileague.com";
const REPO = "catalindelabrasov-droid/ti2026-tracker";
const WORKFLOW = "update.yml";

const SB_URL = Deno.env.get("SUPA_URL") ?? Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPA_SERVICE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GH_TOKEN = Deno.env.get("GH_TOKEN") ?? "";
const TICK_SECRET = Deno.env.get("PUSH_TICK_SECRET") ?? "";

// How stale the data may get before we intervene.
//
// This was 75 because GitHub's own scheduler routinely started the hourly run
// up to 40 minutes late, and anything tighter would have fought a healthy (if
// tardy) scheduler. pg_cron now dispatches the hourly run itself, on the minute,
// so lateness no longer exists: if the data is older than this, something is
// genuinely wrong and waiting another half hour helps nobody.
const STALE_MIN = 45;
// Never poke more often than this, whatever happens. A run takes ~70s; if the
// updater is genuinely broken we want one attempt an hour in the log, not one
// every five minutes.
const COOLDOWN_MIN = 30;

const H = {
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
  "Content-Type": "application/json",
};

async function cfgGet(key: string): Promise<string | null> {
  const r = await fetch(`${SB_URL}/rest/v1/app_config?select=value&key=eq.${key}`, { headers: H });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows.length ? String(rows[0].value).replace(/^"|"$/g, "") : null;
}

async function cfgSet(key: string, value: string) {
  await fetch(`${SB_URL}/rest/v1/app_config?on_conflict=key`, {
    method: "POST",
    headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key, value: JSON.stringify(value), updated_at: new Date().toISOString() }),
  });
}

/* Was a run already dispatched moments ago?
   Guards against two coinciding pg_cron jobs starting two workflow runs in the
   same second — they then race each other to push data.json and the loser fails
   the job for nothing. Deliberately short: this must never suppress the NEXT
   scheduled run, only a duplicate of the one just sent. */
const DUP_WINDOW_SEC = 90;
async function dispatchedRecently(): Promise<boolean> {
  const last = await cfgGet("updater_last_dispatch");
  if (!last) return false;
  const age = (Date.now() - Date.parse(last)) / 1000;
  return Number.isFinite(age) && age >= 0 && age < DUP_WINDOW_SEC;
}

Deno.serve(async (req) => {
  if (TICK_SECRET && req.headers.get("x-tick-secret") !== TICK_SECRET) {
    return new Response("no", { status: 401 });
  }
  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";
  const dry = url.searchParams.get("dry") === "1";
  const fast = url.searchParams.get("fast") === "1";
  const full = url.searchParams.get("full") === "1";

  // The hourly full run, on the same reliable timer as the scoring pass.
  // pg_cron owns the clock now; the workflow no longer carries a schedule of
  // its own, so there is nothing to double-fire against.
  if (full) {
    if (!GH_TOKEN) return Response.json({ ok: false, error: "GH_TOKEN not set" }, { status: 500 });
    /* Never dispatch twice within the same minute.
       On the hour THREE pg_cron jobs fire in the same 4 milliseconds — the
       hourly full-tick and the ten-minute watchdog both land on this function.
       Two workflow runs then start at the same second, both fetch, both commit,
       and one loses the push race and fails the job. The data still gets out
       (the winner publishes) but it emails a red build for something entirely
       benign, which is how a real failure gets ignored. */
    if (!force && (await dispatchedRecently())) {
      return Response.json({ ok: true, action: "skipped-duplicate-full" });
    }
    if (dry) return Response.json({ ok: true, action: "would-dispatch-full" });
    const gh = await fetch(
      `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GH_TOKEN}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "ti-updater-watchdog",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref: "main", inputs: { mode: "full" } }),
      },
    );
    if (gh.status === 204) {
      await cfgSet("updater_last_dispatch", new Date().toISOString());
      return Response.json({ ok: true, action: "dispatched-full" });
    }
    return Response.json(
      { ok: false, action: "full-dispatch-failed", status: gh.status, body: (await gh.text()).slice(0, 200) },
      { status: 502 },
    );
  }

  // The quarter-hour scoring pass.
  //
  // GitHub's `schedule` trigger is the unreliable part — it dropped both the
  // 07:00 and 07:15 slots on TI day two. `workflow_dispatch` fires immediately,
  // so pg_cron keeps the clock and GitHub only runs the job. No staleness check
  // and no cooldown: this is a heartbeat, not a rescue, and it deliberately
  // ignores data.json's age because the fast pass never touches data.json — it
  // writes match_results, which is what league points are scored from.
  if (fast) {
    if (!GH_TOKEN) return Response.json({ ok: false, error: "GH_TOKEN not set" }, { status: 500 });
    if (dry) return Response.json({ ok: true, action: "would-dispatch-fast" });
    const gh = await fetch(
      `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GH_TOKEN}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "ti-updater-watchdog",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref: "main", inputs: { mode: "fast" } }),
      },
    );
    if (gh.status === 204) {
      await cfgSet("scorer_last_dispatch", new Date().toISOString());
      return Response.json({ ok: true, action: "dispatched-fast" });
    }
    return Response.json(
      { ok: false, action: "fast-dispatch-failed", status: gh.status, body: (await gh.text()).slice(0, 200) },
      { status: 502 },
    );
  }

  try {
    // How old is what the site is actually serving?
    const r = await fetch(`${SITE}/data.json`, { headers: { "Cache-Control": "no-cache" } });
    if (!r.ok) return Response.json({ error: `data.json ${r.status}` }, { status: 502 });
    const data = await r.json();
    const stamp = data?.meta?.lastUpdated;
    const ageMin = stamp ? Math.round((Date.now() - Date.parse(stamp)) / 60000) : 99999;

    if (!force && ageMin < STALE_MIN) {
      return Response.json({ ok: true, ageMin, action: "none" });
    }

    // Respect the cooldown so a genuinely broken updater is not hammered.
    const last = await cfgGet("updater_last_dispatch");
    const sinceMin = last ? Math.round((Date.now() - Date.parse(last)) / 60000) : 99999;
    if (!force && sinceMin < COOLDOWN_MIN) {
      return Response.json({ ok: true, ageMin, action: "cooling-off", sinceMin });
    }

    if (dry) return Response.json({ ok: true, ageMin, sinceMin, action: "would-dispatch" });
    if (!GH_TOKEN) return Response.json({ ok: false, ageMin, error: "GH_TOKEN not set" }, { status: 500 });

    const gh = await fetch(
      `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GH_TOKEN}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "ti-updater-watchdog",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref: "main" }),
      },
    );

    if (gh.status === 204) {
      await cfgSet("updater_last_dispatch", new Date().toISOString());
      return Response.json({ ok: true, ageMin, action: "dispatched" });
    }
    return Response.json(
      { ok: false, ageMin, action: "dispatch-failed", status: gh.status, body: (await gh.text()).slice(0, 200) },
      { status: 502 },
    );
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
});
