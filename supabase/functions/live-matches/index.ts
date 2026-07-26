// Supabase Edge Function: live-matches
// The data engine for the Dota hub. One call returns:
//   - liveMatches: live pro games (OpenDota /live), enriched w/ names + logos
//   - tournaments: active + recent pro events, tiered via datdota
//   - topTeams:    world ranking by datdota Glicko-2, named/logo'd via OpenDota
//   - topPlayers:  pros grouped under their ranked team, with role
//   - ladder:      Valve's official ranked ladder, top 100 per region
//   - tiPrize:     TI 2026 main-event prize pool when OpenDota lists it
//   - meta:        current most-picked pro heroes
// Free, no token, no IP lock.
//
// Why three sources: OpenDota's own team `rating` is a noisy Elo that puts
// match-volume grinders and defunct orgs in the top 10 (verified 2026-07-26:
// 6 of its top 10 were unrated by datdota). datdota publishes a curated
// Glicko-2 for the ~35 teams that actually matter, which is what a Dota
// player recognises as a world ranking. OpenDota still supplies names, logos
// and W/L; Valve supplies the official solo ladder.
//
// Deploy:  supabase functions deploy live-matches --no-verify-jwt --use-api
// Browser: GET https://<project>.functions.supabase.co/live-matches
const OD = "https://api.opendota.com/api";
const VALVE_LB = "https://www.dota2.com/webapi/ILeaderboard/GetDivisionLeaderboard/v0001";
const DIVISIONS = ["europe", "americas", "se_asia", "china"];

const UA = { "User-Agent": "dota2tileague/1.0" };
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

// ---- caches (persist across warm invocations) ----
let _leagues: Record<number, any> | null = null;
let _teams: Record<number, { name: string; logo: string | null }> | null = null;
let _tiPrize: { id: number; name: string; prizePool: number } | null = null;
let _tournaments: any[] | null = null;
let _meta: any[] | null = null;
let _heroes: Record<number, any> | null = null;
let _topTeams: any[] | null = null;
let _topPlayers: any[] | null = null;
let _cachedAt = 0;
let _metaAt = 0;
let _playersAt = 0;
let _rosterCache: Record<number, { at: number; players: any[] }> = {};

// datdota state
let _dd: Record<number, any> | null = null;      // valveId -> rating record
let _ddTiers: Record<number, string> | null = null; // leagueId -> PREMIUM|PROFESSIONAL|...
let _ddAsOf: string | null = null;
let _ddAt = 0;
let _ddFailAt = 0;
let _ddInFlight: Promise<void> | null = null;

// Valve ladder state
let _ladder: any = null;
let _ladderAt = 0;

const CACHE_MS = 30 * 60 * 1000;   // 30 min for leagues/teams/tournaments
const META_MS = 60 * 60 * 1000;    // 1 h for hero meta
const DD_MS = 6 * 60 * 60 * 1000;  // 6 h — datdota recomputes Glicko daily at most
const DD_FAIL_MS = 15 * 60 * 1000; // back off 15 min after a datdota failure
const LADDER_MS = 60 * 60 * 1000;  // Valve reposts the ladder hourly

// Generic JSON fetch: never throws, times out, and refuses non-JSON bodies
// (a Cloudflare block page is HTML served with a 2xx in some cases).
async function jurl(url: string, headers: Record<string, string> = UA, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { headers, signal: ctl.signal });
    if (!r.ok) return null;
    const ct = r.headers.get("content-type") || "";
    if (!ct.includes("json")) return null;
    return await r.json();
  } catch (_e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}
async function jget(path: string) { return await jurl(`${OD}${path}`); }

// ---- World ranking + real tournament tiers (read from Supabase) ----
// datdota's Cloudflare returns 403 "cfattack" to this runtime's egress for
// ANY User-Agent (verified from the deployed function on 2026-07-26), so the
// hourly GitHub Action fetches it and writes team_ratings / league_tiers; we
// just read those. See supabase/migrations/0003_team_ratings.sql.
const SB_URL = Deno.env.get("SUPABASE_URL") || "";
const SB_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";

async function loadRatings() {
  if (_dd && Date.now() - _ddAt < DD_MS) return;
  if (Date.now() - _ddFailAt < DD_FAIL_MS) return;   // backing off
  if (_ddInFlight) return await _ddInFlight;         // single-flight
  _ddInFlight = (async () => {
    if (!SB_URL || !SB_KEY) { _ddFailAt = Date.now(); return; }
    const h = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
    const rows = await jurl(
      `${SB_URL}/rest/v1/team_ratings?select=valve_id,name,glicko,glicko_prev,rd,region,as_of&order=glicko.desc`, h);
    if (!Array.isArray(rows) || !rows.length) { _ddFailAt = Date.now(); return; }
    const map: Record<number, any> = {};
    for (const r of rows) {
      if (r.glicko == null || !r.valve_id) continue;
      map[r.valve_id] = {
        glicko: r.glicko,
        glickoPrev: r.glicko_prev,
        rd: r.rd,
        region: r.region,
        ddName: r.name,
      };
    }
    if (!Object.keys(map).length) { _ddFailAt = Date.now(); return; }
    _dd = map;
    _ddAsOf = rows[0]?.as_of || null;
    _ddAt = Date.now();

    // Tiers: only the leagues we might actually show (recent + real).
    const tiers = await jurl(
      `${SB_URL}/rest/v1/league_tiers?select=league_id,tier&order=last_game.desc&limit=1000`, h);
    if (Array.isArray(tiers)) {
      const t: Record<number, string> = {};
      for (const l of tiers) if (l.league_id && l.tier) t[l.league_id] = l.tier;
      _ddTiers = t;
    }
  })().catch(() => { _ddFailAt = Date.now(); })
     .finally(() => { _ddInFlight = null; });
  return await _ddInFlight;
}

// ---- Valve: official ranked ladder, top 100 per region ----
async function loadLadder() {
  if (_ladder && Date.now() - _ladderAt < LADDER_MS) return;
  const out: Record<string, any> = {};
  const results = await Promise.all(
    DIVISIONS.map((d) => jurl(`${VALVE_LB}?division=${d}&leaderboard=0`, UA, 10000)),
  );
  DIVISIONS.forEach((d, i) => {
    const j: any = results[i];
    if (!j || !Array.isArray(j.leaderboard)) return;
    // The raw payload is ~5000 rows / 240 KB per region — slice before caching.
    out[d] = {
      postedAt: j.time_posted || null,
      nextAt: j.next_scheduled_post_time || null,
      players: j.leaderboard.slice(0, 100).map((p: any) => ({
        rank: p.rank,
        name: p.name,
        teamId: p.team_id || null,
        teamTag: p.team_tag || null,
        country: (p.country || "").toLowerCase(),
      })),
    };
  });
  if (Object.keys(out).length) { _ladder = out; _ladderAt = Date.now(); }
}

async function loadLookups() {
  if (_leagues && _teams && (Date.now() - _cachedAt < CACHE_MS)) return;
  try {
    const [lgs, tms, pro] = await Promise.all([
      jget("/leagues"), jget("/teams"), jget("/proMatches"),
    ]);
    // leagues map
    _leagues = {}; _tiPrize = null;
    for (const l of (lgs || [])) {
      if (!l.leagueid) continue;
      _leagues[l.leagueid] = { name: l.name, tier: l.tier || null, prizePool: l.prizepool || 0 };
      const nm = (l.name || "").toLowerCase();
      if (nm.includes("international 2026") && !nm.includes("qualifier") && l.prizepool) {
        _tiPrize = { id: l.leagueid, name: l.name, prizePool: l.prizepool };
      }
    }
    // teams map
    _teams = {};
    for (const t of (tms || [])) if (t.team_id) _teams[t.team_id] = { name: t.name, logo: t.logo_url || null };

    await loadRatings();   // world ranking source

    const odById: Record<number, any> = {};
    for (const t of (tms || [])) if (t.team_id) odById[t.team_id] = t;

    const shape = (id: number, od: any, dd: any, source: string) => {
      const w = od?.wins || 0, l = od?.losses || 0, g = w + l;
      return {
        id,
        name: (dd?.ddName) || od?.name || `Team ${id}`,
        tag: od?.tag || "",
        logo: od?.logo_url || null,
        glicko: dd ? dd.glicko : null,
        glickoDelta: dd && dd.glickoPrev != null ? dd.glicko - dd.glickoPrev : null,
        provisional: dd && dd.rd != null ? dd.rd > 100 : false,
        region: dd?.region || null,
        ratingSource: source,
        rating: dd ? dd.glicko : Math.round(od?.rating || 0),  // legacy key
        wins: w, losses: l,
        winRate: g ? Math.round((w / g) * 100) : 0,
        lastMatch: od?.last_match_time || 0,
      };
    };

    if (_dd && Object.keys(_dd).length) {
      const ranked = Object.keys(_dd)
        .map((k) => Number(k))
        .map((id) => shape(id, odById[id], _dd![id], "datdota"))
        .sort((a, b) => (b.glicko || 0) - (a.glicko || 0));
      // Pad with OpenDota-rated teams so the tab still has depth below the
      // curated set, clearly marked as a different (weaker) rating source.
      const have = new Set(ranked.map((t) => t.id));
      const pad = (tms || [])
        .filter((t: any) => t.team_id && t.name && t.rating && !have.has(t.team_id))
        .sort((a: any, b: any) => (b.rating || 0) - (a.rating || 0))
        .slice(0, 40)
        .map((t: any) => shape(t.team_id, t, null, "opendota"));
      _topTeams = ranked.concat(pad).map((t, i) => ({ ...t, rank: i + 1 }));
    } else {
      // datdota unavailable: fall back to OpenDota's own ordering.
      _topTeams = (tms || [])
        .filter((t: any) => t.team_id && t.name && t.rating)
        .sort((a: any, b: any) => (b.rating || 0) - (a.rating || 0))
        .slice(0, 60)
        .map((t: any, i: number) => ({ ...shape(t.team_id, t, null, "opendota"), rank: i + 1 }));
    }

    // tournaments: derive "active" events from recent pro matches.
    const seen: Record<number, { id: number; last: number; count: number }> = {};
    for (const m of (pro || [])) {
      const id = m.leagueid; if (!id) continue;
      if (!seen[id]) seen[id] = { id, last: 0, count: 0 };
      seen[id].last = Math.max(seen[id].last, m.start_time || 0);
      seen[id].count++;
    }
    _tournaments = Object.values(seen)
      .map((s) => {
        const lg = _leagues![s.id] || {};
        // datdota curates real tiers (PREMIUM / PROFESSIONAL / SEMI_PRO /
        // AMATEUR); OpenDota calls almost everything "professional".
        const ddTier = _ddTiers ? _ddTiers[s.id] : null;
        return {
          id: s.id,
          name: lg.name || `League ${s.id}`,
          tier: ddTier ? ddTier.toLowerCase() : (lg.tier || null),
          tierSource: ddTier ? "datdota" : "opendota",
          prizePool: lg.prizePool || 0,
          lastMatch: s.last,
          recentGames: s.count,
          watch: `https://www.opendota.com/leagues/${s.id}`,
        };
      })
      .filter((t) => t.tier && t.tier !== "amateur")
      .sort((a, b) => (b.lastMatch || 0) - (a.lastMatch || 0));
    _cachedAt = Date.now();
  } catch (_e) { /* keep previous cache */ }
}

async function loadMeta() {
  if (_meta && (Date.now() - _metaAt < META_MS)) return;
  try {
    const hs = await jget("/heroStats");
    if (Array.isArray(hs)) {
      _heroes = {};
      for (const h of hs) _heroes[h.id] = h;
      _meta = hs
        .map((h: any) => {
          const picks = h.pro_pick || 0, wins = h.pro_win || 0, bans = h.pro_ban || 0;
          return {
            id: h.id, name: h.localized_name,
            img: h.img ? `https://cdn.cloudflare.steamstatic.com${h.img}` : null,
            picks, bans, winRate: picks ? Math.round((wins / picks) * 100) : 0,
          };
        })
        .sort((a: any, b: any) => (b.picks + b.bans) - (a.picks + a.bans))
        .slice(0, 12);
      _metaAt = Date.now();
    }
  } catch (_e) { /* keep previous */ }
}

const ROLE_NAME: Record<number, string> = { 1: "Core", 2: "Support", 3: "Support" };

async function loadPlayers() {
  if (_topPlayers && (Date.now() - _playersAt < CACHE_MS)) return;
  try {
    const pp = await jget("/proPlayers");
    if (Array.isArray(pp)) {
      // /proPlayers carries no skill rating at all (rank_tier is null for every
      // one of the ~5000 rows), so a player ladder can only be derived from the
      // strength of the team they play for. Players are therefore ordered by
      // their team's world rank and grouped under it in the UI.
      const byId: Record<number, any> = {};
      for (const t of (_topTeams || [])) byId[t.id] = t;
      // Deliberately no nationality: OpenDota's country_code and
      // loccountrycode are both set by the players themselves and are full of
      // joke values (Saksa -> Vatican, gpk~ -> Afghanistan, SSS -> Åland,
      // verified 2026-07-26). Wrong flags in front of a Dota audience are
      // worse than no flags; Liquipedia would be the source if we want them.
      const seen = new Set<number>();
      _topPlayers = pp
        .filter((p: any) => p.name && p.team_id && byId[p.team_id])
        .map((p: any) => ({ p, t: byId[p.team_id] }))
        .sort((a: any, b: any) => (a.t.rank || 999) - (b.t.rank || 999))
        .filter((x: any) => {           // /proPlayers carries stale duplicate rows
          const id = x.p.account_id;
          if (!id || seen.has(id)) return false;
          seen.add(id); return true;
        })
        .slice(0, 150)
        .map((x: any) => ({
          accountId: x.p.account_id,
          name: x.p.name,
          role: ROLE_NAME[x.p.fantasy_role] || null,
          team: x.t.name,
          teamId: x.t.id,
          teamTag: x.p.team_tag || x.t.tag || null,
          teamRank: x.t.rank,
          teamRating: x.t.rating,
          lastMatch: x.p.last_match_time || null,
          avatar: x.p.avatar || x.p.avatarmedium || null,
          profile: x.p.account_id ? `https://www.opendota.com/players/${x.p.account_id}` : null,
        }));
      _playersAt = Date.now();
    }
  } catch (_e) { /* keep previous */ }
}

// Recent series for one event. OpenDota's API has these leagues even though
// its website has no page for most of them (opendota.com/leagues/19944 renders
// a client-side 404), so we render the detail ourselves instead of sending
// people off-site to a dead page.
const _leagueCache: Record<number, { at: number; data: any }> = {};
async function fetchLeagueDetail(leagueId: number) {
  const c = _leagueCache[leagueId];
  if (c && (Date.now() - c.at < 10 * 60 * 1000)) return c.data;

  const [rows, tms] = await Promise.all([
    jget(`/leagues/${leagueId}/matches`),
    jget(`/leagues/${leagueId}/teams`),
  ]);
  const names: Record<number, { name: string; logo: string | null }> = {};
  for (const t of (Array.isArray(tms) ? tms : [])) {
    if (t.team_id && t.name) names[t.team_id] = { name: t.name, logo: t.logo_url || null };
  }
  // Games -> series, so a Bo3 reads as one 2-1 row rather than three lines.
  const series: Record<string, any> = {};
  for (const g of (Array.isArray(rows) ? rows : [])) {
    const rid = g.radiant_team_id, did = g.dire_team_id;
    const rn = (g.radiant_name || names[rid]?.name || "").trim();
    const dn = (g.dire_name || names[did]?.name || "").trim();
    if (!rn || !dn) continue;
    const [a, b] = [rn, dn].sort((x, y) => x.toLowerCase() < y.toLowerCase() ? -1 : 1);
    const start = g.start_time || 0;
    const key = g.series_id ? String(g.series_id) : `${a}-${b}-${Math.floor(start / 86400)}`;
    const s = series[key] || (series[key] = {
      a, b, sa: 0, sb: 0, start,
      logoA: names[rn === a ? rid : did]?.logo || null,
      logoB: names[rn === b ? rid : did]?.logo || null,
    });
    if (start) s.start = Math.min(s.start || start, start);
    if (g.radiant_win == null) continue;
    const winner = g.radiant_win ? rn : dn;
    if (winner.toLowerCase() === s.a.toLowerCase()) s.sa++; else s.sb++;
  }
  const data = {
    leagueId,
    name: (_leagues && _leagues[leagueId] && _leagues[leagueId].name) || null,
    series: Object.values(series)
      .sort((x: any, y: any) => (y.start || 0) - (x.start || 0))
      .slice(0, 40),
    teams: Object.values(names).map((t: any) => t.name).sort(),
  };
  _leagueCache[leagueId] = { at: Date.now(), data };
  return data;
}

async function fetchRoster(teamId: number) {
  const c = _rosterCache[teamId];
  if (c && (Date.now() - c.at < CACHE_MS)) return c.players;
  const players = await jget(`/teams/${teamId}/players`);
  const current = (Array.isArray(players) ? players : [])
    .filter((p: any) => p.is_current_team_member && p.name)
    .map((p: any) => ({
      accountId: p.account_id, name: p.name,
      games: p.games_played || 0, wins: p.wins || 0,
      profile: p.account_id ? `https://www.opendota.com/players/${p.account_id}` : null,
    }));
  _rosterCache[teamId] = { at: Date.now(), players: current };
  return current;
}

function isPro(g: any) { return g.league_id && g.team_name_radiant && g.team_name_dire; }

function shapeLive(g: any) {
  const mins = g.game_time != null ? Math.max(0, Math.floor(g.game_time / 60)) : null;
  const lg = _leagues && _leagues[g.league_id];
  const evName = (lg && lg.name) || g.league_name || "Pro Match";
  const tA = _teams && _teams[g.team_id_radiant];
  const tB = _teams && _teams[g.team_id_dire];
  const twitch = "https://www.twitch.tv/search?term=" + encodeURIComponent(evName + " dota");
  return {
    id: String(g.match_id), leagueId: g.league_id, event: evName,
    teamA: { name: g.team_name_radiant, score: g.radiant_score ?? 0, logo: tA?.logo ?? null },
    teamB: { name: g.team_name_dire, score: g.dire_score ?? 0, logo: tB?.logo ?? null },
    gameMinute: mins, spectators: g.spectators ?? 0, status: "live",
    watch: twitch, stats: `https://www.opendota.com/matches/${g.match_id}`,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = new URL(req.url);
    // On-demand roster lookup: /live-matches?roster=TEAM_ID
    const rosterId = url.searchParams.get("roster");
    if (rosterId) {
      const players = await fetchRoster(Number(rosterId));
      return new Response(JSON.stringify({ teamId: Number(rosterId), players }),
        { headers: { ...CORS, "Content-Type": "application/json" } });
    }
    // On-demand event detail: /live-matches?league=LEAGUE_ID
    const leagueId = url.searchParams.get("league");
    if (leagueId) {
      await loadLookups();                     // for the league name
      const detail = await fetchLeagueDetail(Number(leagueId));
      return new Response(JSON.stringify(detail),
        { headers: { ...CORS, "Content-Type": "application/json" } });
    }

    await Promise.all([loadLookups(), loadMeta(), loadLadder()]);
    await loadPlayers(); // needs _topTeams from loadLookups
    const games = await jget("/live");
    const liveMatches = (Array.isArray(games) ? games : [])
      .filter(isPro)
      .sort((a: any, b: any) => (b.spectators ?? 0) - (a.spectators ?? 0))
      .slice(0, 25)
      .map(shapeLive);

    const liveLeagueIds = new Set(liveMatches.map((m: any) => m.leagueId));
    const tournaments = (_tournaments || []).map((t) => ({ ...t, live: liveLeagueIds.has(t.id) }));

    return new Response(JSON.stringify({
      liveMatches, tournaments, tiPrize: _tiPrize, meta: _meta || [],
      topTeams: _topTeams || [], topPlayers: _topPlayers || [],
      ladder: _ladder || null,
      ratingsUpdatedAt: _ddAsOf,
      ratingSource: (_dd && Object.keys(_dd).length) ? "datdota" : "opendota",
      updatedAt: new Date().toISOString(),
    }), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({
      error: String(e), liveMatches: [], tournaments: [], meta: [],
      topTeams: [], topPlayers: [], ladder: null,
    }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
