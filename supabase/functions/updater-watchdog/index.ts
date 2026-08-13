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

// How stale the data may get before we intervene. The Action runs hourly, and
// GitHub routinely starts it up to 40 minutes late without anything being
// wrong, so anything under an hour would fight a healthy scheduler.
const STALE_MIN = 75;
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

Deno.serve(async (req) => {
  if (TICK_SECRET && req.headers.get("x-tick-secret") !== TICK_SECRET) {
    return new Response("no", { status: 401 });
  }
  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";
  const dry = url.searchParams.get("dry") === "1";

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
