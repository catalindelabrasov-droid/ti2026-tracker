// Finished league games, straight from Valve.
//
// WHY THIS EXISTS
//
// OpenDota is the only source update_data.py has ever had for FINISHED games,
// and on 20 Aug 2026 — the day the TI playoffs started — it went down twice.
// HTTP 522 from its edge both times, with its own /api/health reporting
// Postgres at 98.5% and Cassandra at 98.8% of limit, so this is capacity
// rather than a blip and it will happen again.
//
// The consequence, measured at 07:26Z: me-r1m2 had been played and finished
// and the site had no result for it — the bracket still read "upcoming" 104
// minutes after kickoff. The Valve fallback shipped that morning covers LIVE
// games (GetLiveLeagueGames) and nothing else, so during an outage the rail
// worked and the results did not.
//
// This returns rows in EXACTLY the shape fetch_opendota_league_games() already
// returns, so update_data.py can fall back to it and none of the roll-up,
// series or clinch logic knows the difference.
//
// It lives in Supabase rather than in the updater because that is where the
// Steam key already is. The GitHub Action has OPENDOTA_API_KEY and the
// Supabase keys and no STEAM_API_KEY; adding a credential to a second place
// during a live event is a worse trade than one HTTPS hop to ourselves.
//
// WHICH VALVE ENDPOINTS, AND WHY NOT THE OBVIOUS ONE
//
// GetMatchDetails is the documented way to get a result and it does not work
// here: measured 20 Aug against real finished TI games, both /v1/ and /V001/
// answer HTTP 500 with a body of exactly "{}". Not a rate limit, not our key —
// it simply does not serve these matches.
//
// So two calls instead:
//   1. GetMatchHistory?league_id  — match_id, match_seq_num, series_id,
//      series_type, both team ids, start_time. No winner.
//   2. GetMatchHistoryBySequenceNum?start_at_match_seq_num=<seq> — the full
//      record including radiant_win, duration and the kill scores. Verified
//      200 with radiant_win present.
//
// TEAM NAMES come from team_ratings.valve_id -> name in our own database.
// Valve returns ids only, and aggregate_series' usual name source is
// OpenDota's /leagues/{id}/teams — down at exactly the moment this runs, which
// would leave every row nameless and silently unmergeable.
//
// A NOTE ON series_id. OpenDota's are unreliable: me-r1m1's two games came
// back series_id null and 1132142, so the roll-up counted one game and
// published a Bo3 as 0-1, a score no Bo3 can end on. Valve's history carries a
// consistent series_id for both, so passing it through is a fix, not merely a
// fallback.

const STEAM_KEY = Deno.env.get("STEAM_API_KEY") ?? "";
const SB_URL = Deno.env.get("SUPABASE_URL") || "";
const SVC_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const HISTORY = "https://api.steampowered.com/IDOTA2Match_570/GetMatchHistory/v1/";
const BY_SEQ = "https://api.steampowered.com/IDOTA2Match_570/GetMatchHistoryBySequenceNum/V001/";
const UA = { "User-Agent": "dota2tileague/1.0" };
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

/* A finished match never changes, so its record is cached for the life of the
   isolate. That is the difference between ~25 Steam calls a request and ~2.
   Bounded so a long tournament cannot grow it without limit; eviction is
   oldest-first and a re-fetch costs one call. */
const _byId = new Map<string, any>();
const CACHE_MAX = 400;

/* team_ratings is refreshed hourly by the updater and changes slowly. */
let _names: Map<number, string> | null = null;
let _namesAt = 0;
const NAMES_TTL = 600_000;

async function jurl(url: string, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { headers: UA, signal: ctl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch (_e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/* Valve's league history is INTERMITTENT, not reliable-or-down. Measured 20 Aug
   over three consecutive calls a second apart: 200, 200, 502. A single attempt
   therefore fails roughly whenever it feels like it, and this endpoint exists
   precisely to be the thing that still works when the other source does not. */
async function jurlRetry(url: string, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    const j = await jurl(url);
    if (j) return j;
    if (i < tries) await new Promise((r) => setTimeout(r, 250 * i));
  }
  return null;
}

/* Bounded concurrency. Firing 25 sequence lookups at once is what appears to
   trip Valve's rate limiter in the first place — the burst is self-inflicted,
   and slowing it down costs a second and buys the whole response. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/* LAST KNOWN GOOD.
   Finished match results do not change, so a stale answer here is not a
   degraded answer - it is the same answer, slightly older. Returning 502 to the
   updater when Valve blinks would reintroduce exactly the hole this endpoint
   was built to close, one layer further down. */
const SHARED_OK = !!SB_URL && !!SVC_KEY;
const svcH = { apikey: SVC_KEY, Authorization: `Bearer ${SVC_KEY}`, "Content-Type": "application/json" };

async function lastGood(key: string): Promise<any | null> {
  if (!SHARED_OK) return null;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3000);
    const r = await fetch(
      `${SB_URL}/rest/v1/edge_cache?select=body,updated_at&key=eq.${encodeURIComponent(key)}`,
      { headers: svcH, signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return null;
    return { body: JSON.parse(String(rows[0].body)), at: rows[0].updated_at };
  } catch (_e) { return null; }
}

function putGood(key: string, body: unknown) {
  if (!SHARED_OK) return;
  /* Deliberately not awaited: the caller already has its answer and must not
     wait on a cache write to hand it over. */
  fetch(`${SB_URL}/rest/v1/edge_cache?on_conflict=key`, {
    method: "POST",
    headers: { ...svcH, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key, body: JSON.stringify(body), updated_at: new Date().toISOString() }),
  }).catch(() => {});
}

async function teamNames(): Promise<Map<number, string>> {
  if (_names && Date.now() - _namesAt < NAMES_TTL) return _names;
  const out = new Map<number, string>();
  if (SB_URL && SVC_KEY) {
    try {
      const r = await fetch(
        `${SB_URL}/rest/v1/team_ratings?select=valve_id,name&valve_id=not.is.null`,
        { headers: { apikey: SVC_KEY, Authorization: `Bearer ${SVC_KEY}` } });
      if (r.ok) {
        for (const t of await r.json()) {
          /* Trailing whitespace is not hypothetical: OpenDota spells one TI
             team 'Nigma Galaxy ' and that single stray space made every Nigma
             fixture invisible to the merge for a whole group stage. */
          if (t?.valve_id && t?.name) out.set(Number(t.valve_id), String(t.name).trim());
        }
      }
    } catch (_e) { /* fall through with whatever we already have */ }
  }
  /* Only replace a good map with a good one. An empty result means the database
     was unreachable, and nameless rows look to the updater exactly like "these
     teams are not playing". */
  if (out.size) { _names = out; _namesAt = Date.now(); }
  return _names ?? out;
}

async function record(m: any) {
  const id = String(m.match_id);
  if (_byId.has(id)) return _byId.get(id);
  const j = await jurl(
    `${BY_SEQ}?key=${encodeURIComponent(STEAM_KEY)}`
    + `&start_at_match_seq_num=${m.match_seq_num}&matches_requested=1`);
  const got = j?.result?.matches?.[0];
  /* The sequence endpoint returns the match AT OR AFTER that number, so a
     missing record hands back somebody else's game. Match the id. */
  if (!got || String(got.match_id) !== id) return null;
  if (typeof got.radiant_win !== "boolean") return null;   // not finished yet
  if (_byId.size >= CACHE_MAX) _byId.delete(_byId.keys().next().value);
  _byId.set(id, got);
  return got;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), {
      status, headers: { ...CORS, "Content-Type": "application/json" },
    });

  try {
    if (!STEAM_KEY) return json({ error: "STEAM_API_KEY not set", rows: null }, 500);
    const url = new URL(req.url);
    const league = url.searchParams.get("league");
    if (!league || !/^[0-9]+$/.test(league)) {
      return json({ error: "league must be a numeric league id", rows: null }, 400);
    }
    /* Bounded so a stray ?limit=5000 cannot turn one request into five thousand
       Steam calls. 25 covers a full playoff day with room to spare. */
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? "25") || 25));

    const cacheKey = `valve-results:${league}:${limit}`;
    const hist = await jurlRetry(
      `${HISTORY}?key=${encodeURIComponent(STEAM_KEY)}`
      + `&league_id=${league}&matches_requested=${limit}`);
    const matches = hist?.result?.matches;
    if (!Array.isArray(matches)) {
      /* Valve blinked. Serve the last good answer rather than nothing: these
         are FINISHED games, so an older copy is the same data, not worse data.
         Flagged stale so the caller can tell. */
      const prev = await lastGood(cacheKey);
      if (prev?.body?.rows?.length) {
        return json({ ...prev.body, stale: true, staleSince: prev.at });
      }
      /* rows: null, NOT []. The caller falls back to this only when OpenDota
         gave it nothing, so it has to tell "Valve says no games" from "Valve
         did not answer" — collapsing the second into the first is how a source
         disappears without anyone noticing. */
      return json({ error: "Valve match history unavailable", rows: null }, 502);
    }

    const [names, records] = await Promise.all([
      teamNames(),
      mapLimit(matches, 5, (m: any) => record(m).catch(() => null)),
    ]);

    const rows: any[] = [];
    matches.forEach((m: any, i: number) => {
      const g = records[i];
      if (!g) return;                                   // still live, or unavailable
      rows.push({
        match_id: g.match_id,
        radiant_name: names.get(Number(m.radiant_team_id)) ?? null,
        dire_name: names.get(Number(m.dire_team_id)) ?? null,
        radiant_team_id: m.radiant_team_id ?? null,
        dire_team_id: m.dire_team_id ?? null,
        radiant_win: g.radiant_win,
        radiant_score: g.radiant_score ?? null,
        dire_score: g.dire_score ?? null,
        start_time: g.start_time ?? m.start_time ?? null,
        duration: g.duration ?? null,
        leagueid: Number(league),
        series_id: m.series_id ?? null,
        series_type: m.series_type ?? null,
      });
    });

    /* Reported separately so a name-resolution failure is visible instead of
       reading as "no games were played". */
    const unnamed = rows.filter((r) => !r.radiant_name || !r.dire_name).length;
    const body = {
      league: Number(league), rows, count: rows.length,
      pending: matches.length - rows.length, unnamed,
      knownTeams: names.size, cached: _byId.size,
      source: "valve", updatedAt: new Date().toISOString(),
    };
    /* Only a USEFUL answer becomes the fallback. Storing an empty or nameless
       one would mean a future outage is served a body that looks fine and says
       nothing happened. */
    if (rows.length && !unnamed) putGood(cacheKey, body);
    return json(body);
  } catch (e) {
    return json({ error: String(e), rows: null }, 500);
  }
});
