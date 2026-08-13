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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = new URL(req.url);
    // On-demand roster lookup: /live-matches?roster=TEAM_ID
    const rosterId = url.searchParams.get("roster");
    if (rosterId) {
      await loadLookups();                  // ranks for the opponent list
      const [players, form] = await Promise.all([
        fetchRoster(Number(rosterId)),
        fetchTeamForm(Number(rosterId)),
      ]);
      return new Response(JSON.stringify({ teamId: Number(rosterId), players, ...form }),
        { headers: { ...CORS, "Content-Type": "application/json" } });
    }
    // One hero's abilities: /live-matches?hero=HERO_ID
    const heroId = url.searchParams.get("hero");
    if (heroId) {
      const detail = await fetchHeroDetail(Number(heroId));
      return new Response(JSON.stringify(detail),
        { headers: { ...CORS, "Content-Type": "application/json" } });
    }
    // Full hero list: /live-matches?heroes=1
    if (url.searchParams.get("heroes")) {
      const heroes = await fetchHeroes();
      return new Response(JSON.stringify({ heroes }),
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
    // OpenDota's /live is a Redis dump with an EIGHT HOUR TTL, fed from
    // Valve's "top games by MMR" endpoint rather than the league one.
    // Measured 2026-07-26: 2 of 100 entries were league games, the median
    // entry was ~4 hours stale, and 17 were matches that had already ended —
    // including one we were happily showing as LIVE. So drop anything that
    // has ended or has gone quiet, and accept showing nothing rather than
    // showing a ghost. (League rows carry Valve's 15-minute broadcast delay,
    // hence the generous window.)
    const nowSec = Math.floor(Date.now() / 1000);
    // Six minutes, not twenty-five.
    //
    // A game that is actually being played refreshes about once a minute;
    // measured during TI, the live ones were 63s old while games that had
    // already finished sat at 863s, 3063s and 4963s. OpenDota does not
    // reliably set deactivate_time when a game ends, so staleness is the only
    // signal — and at 25 minutes a finished game kept showing as live, frozen
    // at "37' LIVE", for a quarter of an hour after it was over. Valve's
    // broadcast delay shifts game_time against the wall clock; it does not
    // slow how often the row is refreshed, which is what this measures.
    const STALE_SEC = 6 * 60;
    const newestByPair: Record<string, any> = {};
    for (const g of (Array.isArray(games) ? games : [])) {
      if (!isPro(g)) continue;
      if (g.deactivate_time) continue;                       // match is over
      const age = nowSec - (g.last_update_time || 0);
      if (!g.last_update_time || age > STALE_SEC) continue;   // feed went quiet
      const pair = [String(g.team_name_radiant), String(g.team_name_dire)]
        .sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : 1).join("|");
      const prev = newestByPair[pair];
      if (!prev || (g.match_id || 0) > (prev.match_id || 0)) newestByPair[pair] = g;
    }
    const liveMatches = Object.values(newestByPair)
      .sort((a: any, b: any) => (b.spectators ?? 0) - (a.spectators ?? 0))
      .slice(0, 25)
      .map(shapeLive);

    // Attach the SERIES score to every live match.
    //
    // The live feed only knows the game currently on the server: its
    // radiant_score/dire_score are kills, and it carries no notion of a Bo3
    // standing at 1-1. Without this a series reads 0-0 from first pick to last
    // game, which is the one number anybody actually wants. The same
    // game-to-series roll-up the event detail already does gives it to us, and
    // it is cached, so this costs one OpenDota round trip per live event.
    const liveLeagueIds = new Set(liveMatches.map((m: any) => m.leagueId));
    try {
      const ids = [...liveLeagueIds].filter(Boolean) as number[];
      const details = await Promise.all(
        ids.map((id) => fetchLeagueDetail(id).catch(() => null)));
      const byLeague: Record<number, any> = {};
      ids.forEach((id, i) => { if (details[i]) byLeague[id] = details[i]; });

      const norm = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      for (const m of liveMatches as any[]) {
        const d = byLeague[m.leagueId];
        if (!d) continue;
        const an = norm(m.teamA?.name), bn = norm(m.teamB?.name);
        if (!an || !bn) continue;
        const s = (d.series || []).find((x: any) => {
          const xa = norm(x.a), xb = norm(x.b);
          return (xa === an && xb === bn) || (xa === bn && xb === an);
        });
        if (!s) continue;
        const flipped = norm(s.a) !== an;
        m.seriesA = flipped ? s.sb : s.sa;
        m.seriesB = flipped ? s.sa : s.sb;
      }
    } catch (e) {
      // A missing series score is a worse card, not a broken page.
      console.error("series attach failed", String(e).slice(0, 200));
    }
    const tournaments = (_tournaments || []).map((t) => ({ ...t, live: liveLeagueIds.has(t.id) }));

    return new Response(JSON.stringify({
      liveMatches, tournaments, tiPrize: _tiPrize, meta: _meta || [],
      topTeams: _topTeams || [], topPlayers: _topPlayers || [],
      ladder: _ladder || null,
      ratingsUpdatedAt: _ddAsOf,
      ratingSource: (_dd && Object.keys(_dd).length)
        ? (_dd[Object.keys(_dd)[0] as any]?.src || "datdota") : "opendota",
      updatedAt: new Date().toISOString(),
    }), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({
      error: String(e), liveMatches: [], tournaments: [], meta: [],
      topTeams: [], topPlayers: [], ladder: null,
    }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
