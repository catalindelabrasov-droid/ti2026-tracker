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

/* WHO IS ACTUALLY PLAYING — Valve, not OpenDota.
 *
 * OpenDota's /live is a Redis dump fed from Valve's "top games by MMR" endpoint,
 * and it does not reliably set deactivate_time when a game ends: the row simply
 * goes quiet. "Finished" and "the dump is lagging" therefore look identical from
 * the outside, and every heuristic below is an attempt to tell them apart from
 * staleness alone.
 *
 * It does not work. On 16 Aug 2026 the front page showed Team Resilience 50-21
 * Team Spirit and GamerLegion 15-25 Iron Wing as LIVE while both were over —
 * their rows sat 0 and 5 minutes behind the freshest row, inside every window
 * here, with no deactivate_time. A 50-21 scoreline at 49 minutes is a finished
 * stomp, and the site said it was in progress. Third occurrence of this bug.
 *
 * GetLiveLeagueGames is Valve's own league feed and is definitive: a match that
 * is not in it is not being played. So it decides LIVENESS, and OpenDota keeps
 * providing the DETAIL (kills, clock, draft) it is good at.
 *
 * Deliberately a gate, not a rewrite. If the key is missing or Valve is
 * unreachable this returns null and the staleness heuristics below run exactly
 * as before — the page degrades to today's behaviour rather than emptying. */
const STEAM_KEY = Deno.env.get("STEAM_API_KEY") ?? "";
const STEAM_LIVE = "https://api.steampowered.com/IDOTA2Match_570/GetLiveLeagueGames/v1/";
let _valve: { at: number; games: any[] } | null = null;
const VALVE_IDS_TTL = 20_000;

/* THE WHOLE PAYLOAD, not just the ids.
 *
 * This used to keep only a Set of match ids, because Valve was only ever a
 * gate over OpenDota's list. On 20 Aug 2026, ninety minutes into the first
 * playoff quarterfinal, OpenDota went down (HTTP 522 from its edge) and the
 * live rail emptied — while THIS call was returning the live game, with teams,
 * kills and series score, the entire time. A gate over an empty list filters
 * nothing. Throwing the payload away was the reason one upstream outage could
 * take the feature down. Keep it; buildValveLive() below turns it into rail
 * entries when OpenDota has nothing to offer. */
async function valveLiveGames(): Promise<any[] | null> {
  if (!STEAM_KEY) return null;
  if (_valve && Date.now() - _valve.at < VALVE_IDS_TTL) return _valve.games;
  try {
    const r = await fetch(`${STEAM_LIVE}?key=${encodeURIComponent(STEAM_KEY)}`, { headers: UA });
    if (!r.ok) return _valve?.games ?? null;
    const j = await r.json();
    const games = j?.result?.games;
    if (!Array.isArray(games)) return _valve?.games ?? null;
    _valve = { at: Date.now(), games };
    return games;
  } catch (_e) { return _valve?.games ?? null; }   // last good answer, else fall back
}

async function valveLiveIds(): Promise<Set<string> | null> {
  const games = await valveLiveGames();
  if (!games) return null;
  return new Set(games.map((g: any) => String(g.match_id)));
}

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
let _tiLeagueId: number | null = null;
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
    // Ordered by the CONSERVATIVE rating — "what we're confident they're at
    // least worth" — so a team with three lucky games can't top the ladder.
    const rows = await jurl(
      `${SB_URL}/rest/v1/team_ratings?select=valve_id,name,glicko,conservative,glicko_prev,rd,region,as_of,source,games&order=conservative.desc.nullslast,glicko.desc`, h);
    if (!Array.isArray(rows) || !rows.length) { _ddFailAt = Date.now(); return; }
    const map: Record<number, any> = {};
    for (const r of rows) {
      if (r.glicko == null || !r.valve_id) continue;
      map[r.valve_id] = {
        glicko: r.glicko,
        // What we're confident they're at least worth; the ladder sorts on it.
        conservative: r.conservative != null ? r.conservative : r.glicko,
        glickoPrev: r.glicko_prev,
        rd: r.rd,
        region: r.region,
        ddName: r.name,
        games: r.games,
        src: r.source || "datdota",
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
    _leagues = {}; _tiPrize = null; _tiLeagueId = null;
    for (const l of (lgs || [])) {
      if (!l.leagueid) continue;
      _leagues[l.leagueid] = { name: l.name, tier: l.tier || null, prizePool: l.prizepool || 0 };
      const nm = (l.name || "").toLowerCase();
      // Remember the id whatever the prize pool says. OpenDota reports TI's
      // prizepool as 0, so gating the id on it meant we never knew which
      // league TI was — and the series roll-up below needs the id, not money.
      if (nm.includes("international 2026") && !nm.includes("qualifier")) {
        _tiLeagueId = l.leagueid;
      }
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
        conservative: dd ? dd.conservative : null,
        glickoDelta: dd && dd.glickoPrev != null ? dd.glicko - dd.glickoPrev : null,
        provisional: dd && dd.rd != null ? dd.rd > 130 : false,
        region: dd?.region || null,
        seriesPlayed: dd?.games ?? null,
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
        .map((id) => shape(id, odById[id], _dd![id], _dd![id].src || "datdota"))
        // Sort on the conservative estimate, NOT the raw rating — otherwise a
        // team with a big rating and a big uncertainty tops the ladder.
        .sort((a, b) => (b.conservative ?? b.glicko ?? 0) - (a.conservative ?? a.glicko ?? 0));
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
  // Three minutes, not ten: this now feeds the live series score, and a Bo3
  // that has just gone 2-1 should not read 1-1 for another quarter of an hour.
  if (c && (Date.now() - c.at < 3 * 60 * 1000)) return c.data;

  /* 25s, not jget's default 8.
     /leagues/<id>/matches was measured at 5.6 seconds and spikes past 12, so an
     8-second timeout dropped it often — and this is what builds tiSeries, which
     carries the roll-up that stops a finished series rendering as live. Every
     time it timed out the payload came back with tiSeries empty, which is both
     wrong on the page and (correctly) refused by the response cache, so the
     stale entry kept being served instead. Slow is fine here; the call is
     cached for three minutes and no longer blocks the page render. */
  const [rows, tms] = await Promise.all([
    jurl(`${OD}/leagues/${leagueId}/matches`, UA, 25000),
    jurl(`${OD}/leagues/${leagueId}/teams`, UA, 25000),
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

// Full hero list for the Heroes page. Served from its own endpoint rather
// than the main payload — 127 heroes is a lot of JSON to ship to everyone who
// only wants the scoreboard.
let _heroList: any[] | null = null;
let _heroListAt = 0;
async function fetchHeroes() {
  if (_heroList && Date.now() - _heroListAt < META_MS) return _heroList;
  const hs = await jget("/heroStats");
  if (!Array.isArray(hs)) return _heroList || [];
  const CDN = "https://cdn.cloudflare.steamstatic.com";
  _heroList = hs.map((h: any) => {
    const pp = h.pro_pick || 0, pb = h.pro_ban || 0, pw = h.pro_win || 0;
    const ub = h.pub_pick || 0, uw = h.pub_win || 0;
    return {
      id: h.id,
      key: (h.name || "").replace("npc_dota_hero_", ""),
      name: h.localized_name,
      attr: h.primary_attr,                     // str | agi | int | all
      attack: h.attack_type,                    // Melee | Ranged
      roles: h.roles || [],
      img: h.img ? CDN + h.img : null,
      icon: h.icon ? CDN + h.icon : null,
      proPick: pp, proBan: pb,
      proWin: pp ? Math.round((pw / pp) * 100) : null,
      pubWin: ub ? Math.round((uw / ub) * 100) : null,
      // Base stats for the detail panel.
      hp: h.base_health, mana: h.base_mana, armor: h.base_armor,
      dmgMin: h.base_attack_min, dmgMax: h.base_attack_max,
      moveSpeed: h.move_speed, attackRange: h.attack_range,
      str: h.base_str, agi: h.base_agi, int: h.base_int,
      strGain: h.str_gain, agiGain: h.agi_gain, intGain: h.int_gain,
      legs: h.legs,
    };
  }).sort((a: any, b: any) => a.name.localeCompare(b.name));
  _heroListAt = Date.now();
  return _heroList;
}

// Hero abilities. The two constants files are big (3,000+ abilities), so they
// are fetched once, cached, and only the requested hero's slice is returned.
let _abilities: any = null;
let _heroAbilities: any = null;
let _constAt = 0;
async function fetchHeroDetail(heroId: number) {
  if (!_abilities || !_heroAbilities || Date.now() - _constAt > 24 * 60 * 60 * 1000) {
    const [ab, ha] = await Promise.all([
      jurl(`${OD}/constants/abilities`, UA, 20000),
      jurl(`${OD}/constants/hero_abilities`, UA, 20000),
    ]);
    if (ab && ha) { _abilities = ab; _heroAbilities = ha; _constAt = Date.now(); }
  }
  const heroes = await fetchHeroes();
  const hero = (heroes || []).find((h: any) => h.id === heroId);
  if (!hero || !_heroAbilities || !_abilities) return { abilities: [], talents: [], facets: [] };

  const entry = _heroAbilities["npc_dota_hero_" + hero.key] || {};
  const CDN = "https://cdn.cloudflare.steamstatic.com";
  const abilities = (entry.abilities || [])
    // Valve pads the list with internal placeholders and sub-abilities.
    .filter((k: string) => k && !k.startsWith("generic_") && !k.endsWith("_release"))
    .map((k: string) => {
      const a = _abilities[k];
      if (!a || !a.dname) return null;
      const arr = (v: any) => Array.isArray(v) ? v.join(" / ") : (v ?? null);
      return {
        key: k,
        name: a.dname,
        desc: a.desc || null,
        lore: a.lore || null,
        type: a.behavior ? (Array.isArray(a.behavior) ? a.behavior.join(", ") : a.behavior) : null,
        dmgType: a.dmg_type || null,
        pierces: a.bkbpierce || null,
        dispellable: a.dispellable || null,
        cooldown: arr(a.cd),
        mana: arr(a.mc),
        damage: arr(a.dmg),
        img: a.img ? CDN + a.img : null,
      };
    })
    .filter(Boolean);

  const facets = (entry.facets || [])
    .filter((f: any) => f && f.title && f.deprecated !== "true")
    .map((f: any) => ({ title: f.title, desc: f.description || null, color: f.color || null }));

  return { heroId, abilities, talents: entry.talents || [], facets };
}

// A team's recent record against RANKED opposition, which is what actually
// explains its position — "beat the #3 side twice" says more than a rating.
async function fetchTeamForm(teamId: number) {
  if (!SB_URL || !SB_KEY) return { series: [] };
  const h = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
  const rows = await jurl(
    `${SB_URL}/rest/v1/pro_series?select=team_a_id,team_a,team_b_id,team_b,score_a,score_b,started_at,tier`
    + `&or=(team_a_id.eq.${teamId},team_b_id.eq.${teamId})`
    + `&tier=in.(premium,professional)&order=started_at.desc&limit=15`, h);
  if (!Array.isArray(rows)) return { series: [] };
  const rankOf: Record<number, any> = {};
  for (const t of (_topTeams || [])) rankOf[t.id] = t;
  return {
    series: rows.map((r: any) => {
      const isA = r.team_a_id === teamId;
      const oppId = isA ? r.team_b_id : r.team_a_id;
      const us = isA ? r.score_a : r.score_b;
      const them = isA ? r.score_b : r.score_a;
      const opp = rankOf[oppId];
      return {
        opponent: isA ? r.team_b : r.team_a,
        opponentId: oppId,
        opponentRank: opp ? opp.rank : null,
        us, them,
        won: us > them,
        at: r.started_at,
        tier: r.tier,
      };
    }),
  };
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
  // League names routinely carry trailing spaces ("EPL Masters 2026 "), which
  // turned the stream search into a double-spaced query.
  const evName = String((lg && lg.name) || g.league_name || "Pro Match")
    .replace(/\s+/g, " ").trim();
  const tA = _teams && _teams[g.team_id_radiant];
  const tB = _teams && _teams[g.team_id_dire];
  const twitch = "https://www.twitch.tv/search?term=" + encodeURIComponent(evName);
  return {
    id: String(g.match_id), leagueId: g.league_id, event: evName,
    teamA: { name: g.team_name_radiant, score: g.radiant_score ?? 0, logo: tA?.logo ?? null },
    teamB: { name: g.team_name_dire, score: g.dire_score ?? 0, logo: tB?.logo ?? null },
    gameMinute: mins, spectators: g.spectators ?? 0, status: "live",
    watch: twitch, stats: `https://www.opendota.com/matches/${g.match_id}`,
  };
}

/* A Valve league game, in the same shape shapeLive produces.
 *
 * Two differences from the OpenDota path, both in Valve's favour:
 *   - the SERIES score comes free (radiant_series_wins / dire_series_wins).
 *     The OpenDota path has to roll games up per league to get it, which is an
 *     extra round trip to the API that is, in this scenario, the thing that is
 *     down.
 *   - scoreboard is absent while the teams are still drafting, so gameMinute
 *     is null there, which is exactly what the page already renders as
 *     "drafting" rather than minute zero.
 *
 * Logos come from the OpenDota team cache when it is warm and are null when it
 * is not. A missing crest is a cosmetic loss; an empty rail is not. */
function shapeValveLive(g: any) {
  const lg = _leagues && _leagues[g.league_id];
  const evName = String((lg && lg.name) || "Pro Match").replace(/\s+/g, " ").trim();
  const sb = g.scoreboard || {};
  const mins = sb.duration != null ? Math.max(0, Math.floor(sb.duration / 60)) : null;
  const rt = g.radiant_team || {};
  const dt = g.dire_team || {};
  const tA = _teams && _teams[rt.team_id];
  const tB = _teams && _teams[dt.team_id];
  return {
    id: String(g.match_id), leagueId: g.league_id, event: evName,
    /* KILLS, not series wins - matching what the OpenDota path puts here.
       The first version used radiant_series_wins, which is truthful (game one
       of a Bo3 really is 0-0) but reads as "nothing is happening" next to the
       35-20 the rail shows the rest of the time. Verified against the live
       quarterfinal on 20 Aug: series wins gave 0-0 while the game was 39
       minutes in. The series standing is carried separately below. */
    teamA: { name: rt.team_name || "Radiant", score: (sb.radiant?.score) ?? 0,
             logo: tA?.logo ?? null },
    teamB: { name: dt.team_name || "Dire", score: (sb.dire?.score) ?? 0,
             logo: tB?.logo ?? null },
    seriesA: g.radiant_series_wins ?? 0, seriesB: g.dire_series_wins ?? 0,
    gameMinute: mins, spectators: g.spectators ?? 0, status: "live",
    watch: "https://www.twitch.tv/search?term=" + encodeURIComponent(evName),
    stats: `https://www.opendota.com/matches/${g.match_id}`,
    source: "valve",
  };
}

/* TI first, then whatever else Valve says is on a server right now.
 * Valve reports spectators as 0 for TI, so sorting on that alone would bury
 * the one event anybody is here for underneath a tier-4 league. */
const TI_LEAGUE_ID = Number(Deno.env.get("TI_LEAGUE_ID") ?? "19719");

function buildValveLive(games: any[]) {
  /* TI ONLY. This is the narrowest useful scope and it is deliberate.
   *
   * GetLiveLeagueGames lists EVERY league game on a Valve server, including
   * amateur and pub-tier leagues, and the OpenDota path's isPro() is only
   * "has a league id and two team names" - it does not screen those out
   * either. The first version of this fallback sorted TI first and kept the
   * rest, which was fine while TI was playing and wrong the moment it stopped:
   * on 20 Aug, minutes after the first quarterfinal ended, the front page of a
   * TI tracker showed "Team Hollow_skies37 0-0 Team Kishi Kaisei" as its LIVE
   * match. That is worse than the honest empty state it replaced - the strip
   * says "No pro matches live right now" and means it.
   *
   * This fallback exists for exactly one job: keep TI visible when OpenDota is
   * unreachable. It should not invent coverage it was never asked for. Between
   * TI matches it now returns nothing and the rail is correctly empty. */
  const ti = _tiLeagueId || TI_LEAGUE_ID;
  return games
    .filter((g: any) => g && g.league_id === ti
      && (g.radiant_team?.team_name) && (g.dire_team?.team_name))
    .sort((a: any, b: any) => (b.spectators ?? 0) - (a.spectators ?? 0))
    .slice(0, 25)
    .map(shapeValveLive);
}

/* ------------------------------------------------------------ response cache
   This endpoint fans out to OpenDota, whose league-matches call answers in
   ~5.6s and whose /leagues list is a one-megabyte download — measured 8 to 19
   SECONDS end to end. The page no longer waits for it, but every visitor still
   triggers that fan-out, and playoff traffic multiplies the callers.

   KEYED ON THE FULL QUERY STRING, deliberately. One function serves at least
   five different shapes — the default feed plus ?hero=, ?heroes=1, ?roster=
   and ?league=. A single global key would hand a Heroes-tab request the
   live-match payload, which is a far worse bug than the slowness it fixes.

   Cache-busting params are stripped from the key: the page appends ?cb=... to
   defeat the BROWSER cache, and honouring that here would mean never hitting
   this one at all. ?fresh=1 is the deliberate way past it. */
type Cached = { at: number; body: string };
const _resp = new Map<string, Cached>();
const RESP_MAX = 200;

/* The key is derived from the SHAPE, in the same order the handler dispatches
   them — never from the raw query string.
   Two reasons. A raw key lets any unrecognised parameter mint a new entry that
   still holds a ~100KB copy of the same default payload, so ?z=1 ... ?z=2400 is
   an unauthenticated way to exhaust the isolate's memory on an endpoint with no
   JWT. And deriving the TTL separately from the dispatch let ?roster=9&hero=5
   return a roster while storing it for an hour. One function, one order. */
function shapeOf(u: URL): { key: string; ttl: number } {
  const p = (k: string) => `${k}=${encodeURIComponent(u.searchParams.get(k) || "")}`;
  if (u.searchParams.get("roster")) return { key: p("roster"), ttl: 300_000 };
  if (u.searchParams.get("hero")) return { key: p("hero"), ttl: 3_600_000 };
  if (u.searchParams.get("heroes")) return { key: "heroes", ttl: 3_600_000 };
  if (u.searchParams.get("league")) return { key: p("league"), ttl: 120_000 };
  return { key: "(default)", ttl: 30_000 };
}

/* The shared layer. The in-memory Map above is kept because it is free when an
   isolate does happen to be reused, but it cannot be relied on: measured 10
   requests out of 10 as misses, four of them in parallel, because Supabase
   hands out a fresh isolate almost every time. Postgres is the only place all
   of them can see. One round trip (~100ms) instead of an 8-19 second fan-out. */
const SVC_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const SHARED_OK = !!SB_URL && !!SVC_KEY;
const svcH = { apikey: SVC_KEY, Authorization: `Bearer ${SVC_KEY}`, "Content-Type": "application/json" };

/* Returns the body AND when it was really written. The `at` matters: re-stamping
   a shared body with Date.now() when copying it into this isolate restarted its
   clock, so a body already 27 seconds old could be served for another 30 —
   measured at 54.7s on a 30-second TTL, and up to two hours on the hero shape. */
async function sharedGet(key: string, ttl: number): Promise<Cached | null> {
  if (!SHARED_OK) return null;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3000);   // never let the cache be the slow part
    const r = await fetch(
      `${SB_URL}/rest/v1/edge_cache?select=body,updated_at&key=eq.${encodeURIComponent(key)}`,
      { headers: svcH, signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return null;
    const at = Date.parse(rows[0].updated_at);
    if (!Number.isFinite(at) || Date.now() - at >= ttl) return null;
    return { at, body: String(rows[0].body) };
  } catch (_e) { return null; }
}

// Fire and forget: a write failure must never slow down or fail a response.
function sharedPut(key: string, body: string) {
  if (!SHARED_OK) return;
  fetch(`${SB_URL}/rest/v1/edge_cache?on_conflict=key`, {
    method: "POST",
    headers: { ...svcH, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key, body, updated_at: new Date().toISOString() }),
  }).catch(() => {});
}

function evict() {
  if (_resp.size < RESP_MAX) return;
  const now = Date.now();
  for (const [k, v] of _resp) if (now - v.at > 3_600_000) _resp.delete(k);
  while (_resp.size >= RESP_MAX) {
    let oldestKey: string | null = null, oldestAt = Infinity;
    for (const [k, v] of _resp) if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k; }
    if (oldestKey === null) break;
    _resp.delete(oldestKey);
  }
}

/* `ok` says the payload is COMPLETE. Storing a degraded one is the worst thing
   this cache could do: jurl() never throws, so a failed upstream comes back as
   a 200 with an empty list, and pinning that under the hero key would leave
   every visitor looking at "Couldn't load heroes" for a full hour — with the
   retry button fetching the same cached emptiness. Before this cache existed
   that self-healed on the very next request. It still must. */
function served(u: URL, body: string, ok = true): Response {
  const { key, ttl } = shapeOf(u);
  if (ok) { evict(); _resp.set(key, { at: Date.now(), body }); sharedPut(key, body); }
  return new Response(body, {
    headers: {
      ...CORS,
      "Content-Type": "application/json",
      "Cache-Control": ok ? `public, max-age=${Math.round(ttl / 1000)}` : "no-store",
      "X-Cache": ok ? "miss" : "bypass",
    },
  });
}

// A hit advertises only the time LEFT, so an intermediary cannot hold a
// 29-second-old body for another 30.
function servedFromCache(u: URL, hit: Cached): Response {
  const { ttl } = shapeOf(u);
  const remain = Math.max(0, Math.round((ttl - (Date.now() - hit.at)) / 1000));
  return new Response(hit.body, {
    headers: {
      ...CORS,
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${remain}`,
      "X-Cache": "hit",
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = new URL(req.url);

    /* ?src=valve — force the OpenDota-is-down path on a healthy day.
     *
     * The fallback below only runs when the rail would otherwise be EMPTY,
     * which means it is exercised exactly when nobody can afford it to be
     * wrong and never when anyone is watching. It was written during the
     * 20 Aug outage and OpenDota recovered ten minutes later, leaving it
     * deployed and unproven - which is worth nothing, and worse than nothing
     * if it throws, because between rounds an empty rail is the HEALTHY state
     * and an exception there would take tournaments, ladder and topTeams down
     * with it.
     *
     * So: a switch, and tools/test_valve_fallback.js drives it against
     * production. It is deliberately excluded from the cache in BOTH
     * directions - shapeOf() maps unknown params to the default key, so a
     * forced response that were allowed to be written would be served to every
     * visitor for the next thirty seconds. */
    const forceValve = url.searchParams.get("src") === "valve";

    if (!forceValve && url.searchParams.get("fresh") !== "1") {
      const { key, ttl } = shapeOf(url);
      const local = _resp.get(key);
      if (local && Date.now() - local.at < ttl) return servedFromCache(url, local);
      // Nothing warm here — ask the shared one before doing the slow work.
      const shared = await sharedGet(key, ttl);
      if (shared) {
        // Carry the REAL write time through, so this isolate expires it when it
        // truly expires rather than thirty seconds from now.
        _resp.set(key, shared);
        return servedFromCache(url, shared);
      }
    }
    // On-demand roster lookup: /live-matches?roster=TEAM_ID
    const rosterId = url.searchParams.get("roster");
    if (rosterId) {
      await loadLookups();                  // ranks for the opponent list
      const [players, form] = await Promise.all([
        fetchRoster(Number(rosterId)),
        fetchTeamForm(Number(rosterId)),
      ]);
      return served(url, JSON.stringify({ teamId: Number(rosterId), players, ...form }),
        Array.isArray(players) && players.length > 0);
    }
    // One hero's abilities: /live-matches?hero=HERO_ID
    const heroId = url.searchParams.get("hero");
    if (heroId) {
      const detail = await fetchHeroDetail(Number(heroId));
      // {abilities:[],talents:[],facets:[]} is exactly what it returns when the
      // constants fetch failed — never pin that for an hour.
      return served(url, JSON.stringify(detail),
        !!detail && (((detail as any).abilities || []).length > 0 ||
                     ((detail as any).talents || []).length > 0));
    }
    // Full hero list: /live-matches?heroes=1
    if (url.searchParams.get("heroes")) {
      const heroes = await fetchHeroes();
      return served(url, JSON.stringify({ heroes }), Array.isArray(heroes) && heroes.length > 0);
    }
    // On-demand event detail: /live-matches?league=LEAGUE_ID
    const leagueId = url.searchParams.get("league");
    if (leagueId) {
      await loadLookups();                     // for the league name
      const detail = await fetchLeagueDetail(Number(leagueId));
      // Series, not "series OR a name". The name comes from _leagues and
      // survives even when /leagues/<id>/matches fails, so the `||` let an
      // empty-but-named detail cache for two minutes.
      return served(url, JSON.stringify(detail),
        !!detail && ((detail as any).series || []).length > 0);
    }

    await Promise.all([loadLookups(), loadMeta(), loadLadder()]);
    await loadPlayers(); // needs _topTeams from loadLookups
    const games = await jget("/live");
    // OpenDota's /live is a Redis dump with an EIGHT HOUR TTL, fed from
    // Valve's "top games by MMR" endpoint rather than the league one.
    // Measured 2026-07-26: 2 of 100 entries were league games, the median
    // entry was ~4 hours stale, and 17 were matches that had already ended —
    // including one we were happily showing as LIVE. So drop anything that
    // has ended or has gone quiet, and accept showing nothing rather than
    // showing a ghost. (League rows carry Valve's 15-minute broadcast delay,
    // hence the generous window.)
    const nowSec = Math.floor(Date.now() / 1000);
    // How long a quiet row may be trusted depends on what it is.
    //
    // OpenDota does not reliably set deactivate_time when a game ends, so
    // staleness is the only signal we have. But it means two different things:
    //
    //  * A game being PLAYED refreshes roughly once a minute. Measured during
    //    TI: live rows were 63s old while finished ones sat at 863s, 3063s and
    //    4963s. Silence here means it is over — at the old 25-minute window a
    //    finished game stayed on screen frozen at "37' LIVE" for a quarter of
    //    an hour.
    //
    //  * A game still in DRAFT (game_time <= 0, horn not gone) updates far
    //    less often. Six minutes wrongly dropped a real match that was sitting
    //    at -10s with an 11-minute-old row, so the page showed three series
    //    when four were in progress.
    //
    // Valve's broadcast delay shifts game_time against the wall clock; it does
    // not change how often the row is written, which is what this measures.
    /* MEASURE STALENESS AGAINST THE SNAPSHOT, NOT THE WALL CLOCK.
       last_update_time is stamped when OpenDota refreshes the whole dump, not
       per game: on 15 Aug all four TI matches carried just two distinct
       timestamps between them. Comparing that to `now` therefore measures how
       far behind OpenDota is, not whether a game is alive — and when the dump
       ran 11-14 minutes late, a 6-minute limit hid all four matches of a live
       round. The site said "No pro matches live right now" while four were
       being played, each 59 to 63 minutes in with no deactivate_time.

       So: a row is current if it was written in the SAME refresh as the newest
       row we can see. deactivate_time above remains the real "it is over"
       signal — Valve sets it — and the absolute cap below still throws the
       whole snapshot away if OpenDota gets properly stuck, which it does: its
       /live is a Redis dump with an eight-hour TTL. */
    const STALE_RUNNING_SEC = 6 * 60;
    const STALE_DRAFT_SEC = 25 * 60;
    const SNAPSHOT_MAX_AGE_SEC = 45 * 60;
    const rows = (Array.isArray(games) ? games : []).filter(isPro);
    const newestStamp = rows.reduce((m, g) => Math.max(m, g.last_update_time || 0), 0);
    const snapshotAge = newestStamp ? nowSec - newestStamp : Infinity;
    const snapshotUsable = snapshotAge <= SNAPSHOT_MAX_AGE_SEC;
    /* Valve's own list of what is on a game server right now. Null means we
       could not ask, in which case the staleness heuristics below stay in
       charge exactly as they were. See valveLiveIds() at the top of the file. */
    const valveIds = await valveLiveIds();

    const newestByPair: Record<string, any> = {};
    for (const g of rows) {
      if (g.deactivate_time) continue;                       // match is over
      if (valveIds) {
        /* AUTHORITATIVE PATH. Valve knows within ~10s. If a match is not on its
           list it is not being played, whatever OpenDota is still serving — and
           if it IS on the list we keep it even when OpenDota's row has gone
           quiet, because dropping a genuinely live match is the other failure
           this code has already had (four matches hidden while being played on
           15 Aug). Staleness stops deciding anything once Valve can answer. */
        if (!valveIds.has(String(g.match_id))) continue;
      } else {
        if (!snapshotUsable) continue;                       // the whole dump is stuck
        const age = newestStamp - (g.last_update_time || 0); // behind THIS snapshot
        // A negative or zero game_time means the horn has not gone yet.
        const drafting = (g.game_time ?? 0) <= 0;
        const limit = drafting ? STALE_DRAFT_SEC : STALE_RUNNING_SEC;
        if (!g.last_update_time || age > limit) continue;     // feed went quiet
      }
      const pair = [String(g.team_name_radiant), String(g.team_name_dire)]
        .sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : 1).join("|");
      const prev = newestByPair[pair];
      if (!prev || (g.match_id || 0) > (prev.match_id || 0)) newestByPair[pair] = g;
    }
    let liveMatches = Object.values(newestByPair)
      .sort((a: any, b: any) => (b.spectators ?? 0) - (a.spectators ?? 0))
      .slice(0, 25)
      .map(shapeLive);

    /* FALL BACK TO VALVE WHEN OPENDOTA HAS NOTHING.
       Not "when OpenDota errored" - when the rail would be EMPTY. Those are
       different: OpenDota can answer 200 with an empty or stale dump, which is
       what a 522 upstream of it looks like from here, and the old code treated
       that as "no matches are being played". Valve is the authority on what is
       on a game server, so if it lists games and we are about to show none, it
       wins. Between rounds it lists nothing either and the rail is correctly
       empty. */
    let liveSource = "opendota";
    if (liveMatches.length === 0 || forceValve) {
      const vgames = await valveLiveGames();
      if (vgames && vgames.length) {
        const fromValve = buildValveLive(vgames);
        if (fromValve.length) { liveMatches = fromValve; liveSource = "valve"; }
      }
    }

    // Attach the SERIES score to every live match.
    //
    // The live feed only knows the game currently on the server: its
    // radiant_score/dire_score are kills, and it carries no notion of a Bo3
    // standing at 1-1. Without this a series reads 0-0 from first pick to last
    // game, which is the one number anybody actually wants. The same
    // game-to-series roll-up the event detail already does gives it to us, and
    // it is cached, so this costs one OpenDota round trip per live event.
    const liveLeagueIds = new Set(
      liveSource === "valve" ? [] : liveMatches.map((m: any) => m.leagueId));
    /* Skipped entirely on the Valve path. radiant_series_wins IS the series
       score, already on each entry, and fetchLeagueDetail would spend an
       eight-second timeout against the API that is down only to return null
       and leave those numbers alone. */
    try {
      const ids = [...liveLeagueIds].filter(Boolean) as number[];
      const details = await Promise.all(
        ids.map((id) => fetchLeagueDetail(id).catch(() => null)));
      const byLeague: Record<number, any> = {};
      ids.forEach((id, i) => { if (details[i]) byLeague[id] = details[i]; });

      const norm = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      // /live and /leagues/{id}/matches do not always spell a team the same way
      // ("Aurora" vs "Aurora Gaming"), so fall back to the name with its org
      // decoration stripped before giving up on the pairing.
      const key = (s: unknown) =>
        norm(s).replace(/[.\-_'"]/g, " ")
               .replace(/\b(gaming|esports?|e-sports|club|team|the|ti|20\d\d)\b/g, " ")
               .replace(/\s+/g, " ").trim();
      for (const m of liveMatches as any[]) {
        const d = byLeague[m.leagueId];
        if (!d) continue;
        const an = norm(m.teamA?.name), bn = norm(m.teamB?.name);
        if (!an || !bn) continue;
        const list = (d.series || []);
        let s = list.find((x: any) => {
          const xa = norm(x.a), xb = norm(x.b);
          return (xa === an && xb === bn) || (xa === bn && xb === an);
        });
        if (!s) {
          const ka = key(m.teamA?.name), kb = key(m.teamB?.name);
          if (ka && kb && ka !== kb) {
            const hits = list.filter((x: any) => {
              const xa = key(x.a), xb = key(x.b);
              return (xa === ka && xb === kb) || (xa === kb && xb === ka);
            });
            if (hits.length === 1) s = hits[0];
          }
        }
        if (!s) {
          // We hold this league's finished games and none belong to this pair,
          // so the series really is 0-0. Left undefined it reached the page as
          // "unknown" and rendered as a dash, which reads like the score is
          // missing rather than nobody having won a game yet.
          m.seriesA = 0; m.seriesB = 0;
          continue;
        }
        const flipped = norm(s.a) !== an && key(s.a) !== key(m.teamA?.name);
        m.seriesA = flipped ? s.sb : s.sa;
        m.seriesB = flipped ? s.sa : s.sb;
      }
    } catch (e) {
      // A missing series score is a worse card, not a broken page.
      console.error("series attach failed", String(e).slice(0, 200));
    }

    // Every TI series, decided or not — not just the ones still being played.
    //
    // A series drops out of the live feed the moment it ends, and the page then
    // falls back to the published schedule, which Liquipedia updates minutes
    // later. That is how BoomBoys v OG sat on the site reading 1-0 and "live"
    // when it had actually finished 2-0. Shipping the whole roll-up means the
    // page never has to fall back to a slower source.
    let tiSeries: any[] = [];
    try {
      if (_tiLeagueId) {
        const det = await fetchLeagueDetail(_tiLeagueId);
        tiSeries = (det && det.series) || [];
      }
    } catch (e) {
      console.error("tiSeries failed", String(e).slice(0, 200));
    }
    const tournaments = (_tournaments || []).map((t) => ({ ...t, live: liveLeagueIds.has(t.id) }));

    return served(url, JSON.stringify({
      liveMatches, liveSource, tournaments, tiPrize: _tiPrize,
      /* Fall back to the constant. _tiLeagueId is discovered from OpenDota's
         league list, so during an OpenDota outage it is null - and the page's
         isTIMatch() uses it to decide what belongs in the TI-only strip. Null
         sends it down a team-name path exactly when the feed is degraded. */
      tiLeagueId: _tiLeagueId || TI_LEAGUE_ID, tiSeries,
      meta: _meta || [],
      topTeams: _topTeams || [], topPlayers: _topPlayers || [],
      ladder: _ladder || null,
      ratingsUpdatedAt: _ddAsOf,
      ratingSource: (_dd && Object.keys(_dd).length)
        ? (_dd[Object.keys(_dd)[0] as any]?.src || "datdota") : "opendota",
      updatedAt: new Date().toISOString(),
      // Only cache a payload whose loaders actually succeeded. A cold isolate
      // can answer 200 with a third of the content while ratings are still
      // backing off, and pinning that would serve everyone the thin version.
      //
      // tiSeries is in this list because it is LOAD-BEARING, not cosmetic: it
      // carries the roll-up that stops a finished series rendering as live. Its
      // build has its own try/catch, so it fails quietly to an empty array —
      // and the first version of this gate did not check it, so a payload with
      // tiSeries=[] was cached and served for thirty seconds while ?fresh=1
      // returned 24. If we know TI exists, its series must be there.
    //
    // tiSeries is required OUTRIGHT. The first version excused it when
    // _tiLeagueId was null — but that is set by the same lookup whose failure
    // empties tiSeries, so the excuse fired exactly when the payload was
    // broken, and series=0 was cached and served anyway. Measured: five of six
    // consecutive responses came back with no series at all.
    // If TI is genuinely over and there are no series, this simply declines to
    // cache. That costs speed on an endpoint the page no longer waits for, and
    // never costs correctness.
    //
    // topPlayers and the /live fetch are in here because they are what actually
    // failed in practice. Measured over 54 samples: 45 responses were served
    // from cache with topPlayers empty — the Players tab read "No player data
    // yet" while a bypass returned 150 — and one pinned body carried
    // liveMatches: 0 while four TI matches were being played.
    //
    // The /live test is `Array.isArray(games)`, NOT `liveMatches.length > 0`:
    // between rounds there genuinely is nothing live, and refusing to cache
    // then would be wrong. jget returns null on failure and an array on
    // success, so the array is the honest signal for "we actually asked".
    }), !forceValve && !!_leagues && !!_teams &&
        Array.isArray(_topTeams) && _topTeams.length > 0 &&
        Array.isArray(_topPlayers) && _topPlayers.length > 0 &&
        Array.isArray(games) &&
        Array.isArray(tiSeries) && tiSeries.length > 0);
  } catch (e) {
    // Deliberately NOT cached: an upstream blip must not be pinned in front of
    // every visitor for the next thirty seconds.
    return new Response(JSON.stringify({
      error: String(e), liveMatches: [], tournaments: [], meta: [],
      topTeams: [], topPlayers: [], ladder: null,
    }), { status: 200, headers: { ...CORS, "Content-Type": "application/json", "X-Cache": "bypass" } });
  }
});
