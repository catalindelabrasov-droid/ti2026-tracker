// Live match detail + stream resolution, for the "watch on our site" page.
//
// DELIBERATELY A SEPARATE FUNCTION from live-matches. That one feeds the whole
// live site — cards, ticker, group table, league scoring — and this is new work.
// Nothing here can take that down.
//
//   ?streams=1     which official channel is showing which match, per language
//   (no params)    every live TI match: draft, kills, net worth lead, streams
//
// On sources:
//   STRATZ was the obvious choice and is NOT usable here. Its free token is
//   bound to the IP that created it ("You cannot use different IP Addresses when
//   using the API"), and an edge function has a datacenter IP, so the parked
//   STRATZ_TOKEN returns 403 no matter what.
//   Valve's GetLiveLeagueGames is the primary source now — see STEAM_LIVE below.
//   It carries the real series score, the draft flag and per-player detail, and
//   reports its own stream delay (10s at TI 2026, not the 15 min folklore).
//   OpenDota's /live is the fallback: no credentials, and it carries
//   radiant_lead and the full draft with pro player names.
//
// The stream half USED to scrape twitch.tv channel pages for isLiveBroadcast.
// It no longer does, on two counts. It was ~4 MB of HTML per refresh to answer
// a yes/no question and broke whenever Twitch changed a template; and the
// Twitch Developer Services Agreement (XI.I) permits only documented endpoints.
// It now calls Helix once for all fourteen channels. See resolveStreams().

const OPENDOTA = "https://api.opendota.com/api";
const UA = { "User-Agent": "dota2tileague/1.0 (https://dota2tileague.com)" };

/* Valve's own live feed.
   This is the authority and it solves at source the problem OpenDota created:
   GetLiveLeagueGames returns ONLY games actually being played, so finished games
   never appear at all and the frozen-clock heuristic below becomes a fallback
   rather than the primary test. It also carries what OpenDota does not — the
   real series score (radiant_series_wins, no waiting for game 1 to be parsed),
   per-player net worth/level/KDA/items, the full pick-ban order, tower and
   barracks state and the Roshan timer.

   THE KEY IS THE SITE OWNER'S PERSONAL STEAM KEY. It stays server-side: this
   function calls Valve and returns shaped data, so the key never reaches a
   browser. Never inline it into a page. 100k calls/day, hence the cache. */
const STEAM_KEY = Deno.env.get("STEAM_API_KEY") ?? "";
const STEAM_LIVE = "https://api.steampowered.com/IDOTA2Match_570/GetLiveLeagueGames/v1/";

let _valve: { at: number; data: any[] } | null = null;
const VALVE_TTL = 8_000;   // the page polls every 20s; this keeps us well inside quota

async function valveLive(league: number): Promise<any[] | null> {
  if (!STEAM_KEY) return null;
  if (_valve && Date.now() - _valve.at < VALVE_TTL) return _valve.data;
  try {
    const r = await fetch(`${STEAM_LIVE}?key=${encodeURIComponent(STEAM_KEY)}&league_id=${league}`, { headers: UA });
    if (!r.ok) return _valve?.data ?? null;
    const j = await r.json();
    const games = j?.result?.games;
    if (!Array.isArray(games)) return _valve?.data ?? null;
    _valve = { at: Date.now(), data: games };
    return games;
  } catch (_e) {
    return _valve?.data ?? null;   // keep serving the last good snapshot
  }
}

// Official TI 2026 channels, taken from Liquipedia's event page.
const CHANNELS: Array<{ c: string; lang: string }> = [
  { c: "dota2ti", lang: "EN" }, { c: "dota2ti_2", lang: "EN" },
  { c: "dota2ti_3", lang: "EN" }, { c: "dota2ti_4", lang: "EN" },
  { c: "dota2ti_ru", lang: "RU" }, { c: "dota2ti_ru_2", lang: "RU" },
  { c: "dota2ti_ru_3", lang: "RU" }, { c: "dota2ti_ru_4", lang: "RU" },
  { c: "dota2ti_cn", lang: "CN" }, { c: "dota2ti_cn_2", lang: "CN" },
  { c: "dota2ti_es", lang: "ES" }, { c: "dota2ti_es_2", lang: "ES" },
  { c: "dota2_maincast", lang: "UA" }, { c: "arabicdota", lang: "AR" },
];

const norm = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
// Same loose key the site uses: the client says "Aurora Gaming", fixtures say
// "Aurora", and a stream title may say either.
// Spaces are stripped entirely at the end: a stream title said "Boom Boys" while
// the game server said "BoomBoys", and that one space was enough to lose the
// match between them.
const tkey = (s: unknown) =>
  norm(s).replace(/[.\-_'"]/g, " ")
    .replace(/\b(gaming|esports?|e-sports|club|team|the|ti|20\d\d)\b/g, " ")
    .replace(/\s+/g, "").trim();

let _streams: { at: number; data: any[] } | null = null;
let _heroes: { at: number; data: Record<string, any> } | null = null;
const STREAM_TTL = 90_000;
const HERO_TTL = 6 * 60 * 60 * 1000;

/* Twitch's documented API, not the web page.
 *
 * This used to fetch https://twitch.tv/<channel> for all fourteen channels and
 * regex the HTML for "isLiveBroadcast". That is roughly 4 MB of markup per
 * refresh to answer a yes/no question, and it broke silently whenever Twitch
 * changed a template.
 *
 * It is also no longer allowed. The Twitch Developer Services Agreement,
 * section XI.I: "unless you have Twitch's prior written permission, [you] will
 * only access Program Materials documented on the Twitch Developer Site."
 * Scraping the page is not documented access. Helix is.
 *
 * The credentials stay server-side, exactly like STEAM_KEY: this function calls
 * Twitch and returns shaped data, so the secret never reaches a browser.
 *
 * DEGRADES, NEVER BREAKS. The same agreement (section IX) lets Twitch revoke
 * access "for any reason or no reason at all, at any time", so every failure
 * path here serves the last good snapshot and, failing that, an empty list.
 * No stream links is a worse page; a thrown error is a broken one. */
const TWITCH_ID = Deno.env.get("TWITCH_CLIENT_ID") ?? "";
const TWITCH_SECRET = Deno.env.get("TWITCH_CLIENT_SECRET") ?? "";

let _tok: { v: string; exp: number } | null = null;
async function twitchToken(): Promise<string | null> {
  if (!TWITCH_ID || !TWITCH_SECRET) return null;
  if (_tok && Date.now() < _tok.exp) return _tok.v;
  try {
    const r = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: TWITCH_ID, client_secret: TWITCH_SECRET, grant_type: "client_credentials",
      }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j?.access_token) return null;
    // Tokens last ~54 days; re-fetch an hour early rather than on the cliff.
    _tok = { v: j.access_token, exp: Date.now() + Math.max(60_000, (j.expires_in - 3600) * 1000) };
    return _tok.v;
  } catch (_e) { return null; }
}

async function resolveStreams() {
  if (_streams && Date.now() - _streams.at < STREAM_TTL) return _streams.data;
  const tok = await twitchToken();
  if (!tok) return _streams?.data ?? [];
  try {
    // ONE request for every channel. Helix omits offline channels entirely, so
    // presence in the response IS the liveness answer - no marker to grep for.
    const qs = CHANNELS.map(({ c }) => `user_login=${encodeURIComponent(c)}`).join("&");
    const r = await fetch(`https://api.twitch.tv/helix/streams?${qs}&first=100`, {
      headers: { "Client-Id": TWITCH_ID, Authorization: `Bearer ${tok}` },
    });
    if (!r.ok) return _streams?.data ?? [];
    const j = await r.json();
    const byLogin: Record<string, any> = {};
    for (const s of (j?.data ?? [])) byLogin[String(s.user_login || "").toLowerCase()] = s;

    const data = CHANNELS.map(({ c, lang }) => {
      const s = byLogin[c.toLowerCase()];
      if (!s) return null;                                   // not live
      const title = String(s.title || "").replace(/\s+/g, " ").trim();
      // Same shape the title always had; the old code read it out of the page's
      // meta description, which was this string plus Twitch's own suffix.
      const m = title.match(/\[[A-Z]{2}[-\s]?[A-Z]?\]\s*(.+?)\s+vs\.?\s+(.+?)\s*[-|]/i);
      return {
        channel: c, lang, url: `https://www.twitch.tv/${c}`,
        title: title.slice(0, 160),
        teamA: m ? m[1].trim() : null,
        teamB: m ? m[2].trim() : null,
        // New, and not yet used by anything - see the note on replays below.
        viewers: typeof s.viewer_count === "number" ? s.viewer_count : null,
        startedAt: s.started_at ?? null,
        game: s.game_name ?? null,
        twitchLang: s.language ?? null,
      };
    }).filter(Boolean) as any[];

    _streams = { at: Date.now(), data };
    return data;
  } catch (_e) { return _streams?.data ?? []; }
}

// Team logos.
//
// /live gives team_logo_radiant as a bare UGC id ("2026094195660244377"), which
// cannot be turned into a URL — the real one carries a content hash. The league
// teams endpoint has the full logo_url, so map it by team_id instead.
let _teams: { at: number; league: number; data: Record<string, any> } | null = null;
const TEAM_TTL = 30 * 60 * 1000;
async function teamLogos(league: number): Promise<Record<string, any>> {
  if (_teams && _teams.league === league && Date.now() - _teams.at < TEAM_TTL) return _teams.data;
  try {
    const r = await fetch(`${OPENDOTA}/leagues/${league}/teams`, { headers: UA });
    const rows = await r.json();
    const map: Record<string, any> = {};
    (rows || []).forEach((t: any) => {
      if (t.team_id) map[String(t.team_id)] = { name: t.name || null, logo: t.logo_url || null };
    });
    _teams = { at: Date.now(), league, data: map };
    return map;
  } catch (_e) { return _teams?.data ?? {}; }
}

/* Which games are actually over.
   /live keeps finished games around for hours and its last_update_time is stamped
   when the whole snapshot refreshes, not per game — every entry showed "145s ago"
   at once, so staleness alone cannot tell a live game from a dead one. The league's
   finished-game list is the authority: aggregate it into series and drop anything
   already settled. That is what stopped Aurora 2-0 GamerLegion from sitting on the
   page at "41 minutes" after the series had ended. */
let _fin: {
  at: number; league: number; ids: Set<string>; decided: Set<string>;
  wins: Record<string, Record<string, number>>;
} | null = null;
const FIN_TTL = 120_000;
async function finished(league: number) {
  if (_fin && _fin.league === league && Date.now() - _fin.at < FIN_TTL) return _fin;
  const ids = new Set<string>();
  const wins: Record<string, Record<string, number>> = {};
  try {
    const [gamesR, teamsR] = await Promise.all([
      fetch(`${OPENDOTA}/leagues/${league}/matches`, { headers: UA }).then(r => r.json()),
      fetch(`${OPENDOTA}/leagues/${league}/teams`, { headers: UA }).then(r => r.json()),
    ]);
    const tn: Record<string, string> = {};
    (teamsR || []).forEach((t: any) => { if (t.team_id && t.name) tn[String(t.team_id)] = t.name; });
    (gamesR || []).forEach((g: any) => {
      ids.add(String(g.match_id));
      const r = (g.radiant_name || tn[String(g.radiant_team_id)] || "").trim();
      const d = (g.dire_name || tn[String(g.dire_team_id)] || "").trim();
      if (!r || !d || g.radiant_win == null) return;
      const k = [tkey(r), tkey(d)].sort().join("|");
      wins[k] = wins[k] || {};
      const w = tkey(g.radiant_win ? r : d);
      wins[k][w] = (wins[k][w] || 0) + 1;
    });
  } catch (_e) { /* fall through with whatever we managed */ }
  const decided = new Set<string>();
  Object.entries(wins).forEach(([k, w]) => {
    if (Math.max(...Object.values(w)) >= 2) decided.add(k);   // Bo3
  });
  _fin = { at: Date.now(), league, ids, decided, wins };
  return _fin;
}

/* Item id -> name and icon. Valve's live feed gives item0..item5 as bare ids,
   which are meaningless on screen without this. 501 items, so cache it hard. */
let _items: { at: number; data: Record<string, any> } | null = null;
async function items(): Promise<Record<string, any>> {
  if (_items && Date.now() - _items.at < HERO_TTL) return _items.data;
  try {
    const r = await fetch(`${OPENDOTA}/constants/items`, { headers: UA });
    const raw = await r.json();
    const map: Record<string, any> = {};
    Object.values(raw || {}).forEach((it: any) => {
      if (it && it.id != null) {
        map[String(it.id)] = {
          name: it.dname || null,
          img: it.img ? `https://cdn.cloudflare.steamstatic.com${it.img}` : null,
          cost: it.cost ?? null,
        };
      }
    });
    _items = { at: Date.now(), data: map };
    return map;
  } catch (_e) { return _items?.data ?? {}; }
}

async function heroes(): Promise<Record<string, any>> {
  if (_heroes && Date.now() - _heroes.at < HERO_TTL) return _heroes.data;
  try {
    const r = await fetch(`${OPENDOTA}/heroStats`, { headers: UA });
    const rows = await r.json();
    const map: Record<string, any> = {};
    (rows || []).forEach((h: any) => {
      map[String(h.id)] = {
        name: h.localized_name,
        attr: h.primary_attr,
        img: h.img ? `https://cdn.cloudflare.steamstatic.com${h.img}` : null,
        icon: h.icon ? `https://cdn.cloudflare.steamstatic.com${h.icon}` : null,
      };
    });
    _heroes = { at: Date.now(), data: map };
    return map;
  } catch (_e) { return _heroes?.data ?? {}; }
}

function streamsFor(streams: any[], a: string, b: string) {
  const ka = tkey(a), kb = tkey(b);
  if (!ka || !kb) return [];
  return streams
    .filter(s => {
      if (!s.teamA || !s.teamB) return false;
      const x = tkey(s.teamA), y = tkey(s.teamB);
      return (x === ka && y === kb) || (x === kb && y === ka);
    })
    .map(s => ({ channel: s.channel, lang: s.lang, url: s.url, title: s.title }));
}

/* Is the game actually being played?
   Measured 13 Aug 2026: of ten TI entries in /live, SEVEN had a frozen clock —
   ended games that OpenDota keeps serving for hours. last_update_time is useless
   for this because it is stamped when the whole snapshot refreshes, so every
   entry reads the same few seconds old whether it is live or long dead. And
   deactivate_time is only set on some of them.
   A live game's clock advances; a dead one's does not. So sample game_time and
   compare against the previous sample. The page polls every 20s, which keeps
   this isolate warm and the samples flowing.
   A frozen entry is NOT marked dead permanently — a technical pause also freezes
   the clock, and the stored sample is deliberately left untouched so the game
   reappears the moment its clock moves again. */
type Sample = { gt: number; at: number };
const _clock = new Map<string, Sample>();
const CLOCK_GAP_MS = 45_000;   // samples must be this far apart to judge
// Only used before two samples exist. Live games measured ~1000s of drift,
// finished ones 1600–8800s, so this is deliberately generous: better to show a
// dead game for one poll than to hide a live one.
const COLD_DRIFT_MAX = 2400;

function isBeingPlayed(g: any, nowSec: number): boolean {
  const id = String(g.match_id);
  const gt = g.game_time ?? 0;
  const nowMs = Date.now();
  const prev = _clock.get(id);
  if (!prev) {
    _clock.set(id, { gt, at: nowMs });
    const drift = (nowSec - (g.activate_time ?? nowSec)) - gt;
    return drift <= COLD_DRIFT_MAX;
  }
  if (nowMs - prev.at < CLOCK_GAP_MS) return true;      // too soon to tell; keep showing
  if (gt > prev.gt) { _clock.set(id, { gt, at: nowMs }); return true; }
  return false;                                          // clock stopped
}

/* Shape Valve's game into the same object the page already renders, so the
   front end needs no change and OpenDota can still stand in if Valve is down. */
function shapeValve(g: any, heroMap: Record<string, any>, teamMap: Record<string, any>,
                    itemMap: Record<string, any>, streams: any[]) {
  const sb = g.scoreboard ?? {};
  const a = (g.radiant_team?.team_name || "Radiant").trim();
  const b = (g.dire_team?.team_name || "Dire").trim();
  const dur = sb.duration ?? 0;
  // Valve's scoreboard players carry stats but NO name — the handles live in a
  // separate top-level players array, joined by account_id.
  const names: Record<string, string> = {};
  (g.players ?? []).forEach((p: any) => {
    if (p.account_id != null && p.name) names[String(p.account_id)] = p.name;
  });
  const side = (s: any) => (s?.players ?? []).map((p: any) => ({
    player: names[String(p.account_id)] || p.name || null,
    heroId: p.hero_id,
    hero: heroMap[String(p.hero_id)]?.name || null,
    img: heroMap[String(p.hero_id)]?.img || null,
    // the detail OpenDota never had
    level: p.level ?? null,
    kills: p.kills ?? null,
    deaths: p.death ?? null,      // Valve spells it "death", singular
    assists: p.assists ?? null,
    netWorth: p.net_worth ?? null,
    gpm: p.gold_per_min ?? null,
    xpm: p.xp_per_min ?? null,
    lastHits: p.last_hits ?? null,
    denies: p.denies ?? null,
    gold: p.gold ?? null,
    // Item slot 0 means empty; keep the slot so the layout does not jump around
    // as things are bought and sold.
    items: [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5].map((id: any) => {
      if (!id) return null;
      const it = itemMap[String(id)];
      return it ? { id, name: it.name, img: it.img } : { id, name: null, img: null };
    }),
    // 0 not ready, 1 no mana, 2 ready — useful, and nothing else exposes it
    ultState: p.ultimate_state ?? null,
    ultCooldown: p.ultimate_cooldown ?? null,
    respawn: p.respawn_timer ?? null,
  }));
  const nw = (s: any) => (s?.players ?? []).reduce((t: number, p: any) => t + (p.net_worth ?? 0), 0);
  const logo = (id: any, name: string) =>
    teamMap[String(id)]?.logo
    ?? Object.values(teamMap).find((t: any) => tkey(t.name) === tkey(name))?.logo
    ?? null;

  return {
    matchId: String(g.match_id),
    seriesId: null,
    startedAgo: null,
    source: "valve",
    // Valve only returns live games, so anything here is being played. Before
    // the horn the clock sits at 0 and the draft is still happening.
    drafting: dur <= 0,
    gameMinute: dur > 0 ? Math.floor(dur / 60) : 0,
    delaySec: g.stream_delay_s ?? null,
    spectators: g.spectators ?? 0,
    radiant: {
      name: a, kills: sb.radiant?.score ?? 0, teamId: g.radiant_team?.team_id ?? null,
      logo: logo(g.radiant_team?.team_id, a), players: side(sb.radiant),
      towers: sb.radiant?.tower_state ?? null, barracks: sb.radiant?.barracks_state ?? null,
    },
    dire: {
      name: b, kills: sb.dire?.score ?? 0, teamId: g.dire_team?.team_id ?? null,
      logo: logo(g.dire_team?.team_id, b), players: side(sb.dire),
      towers: sb.dire?.tower_state ?? null, barracks: sb.dire?.barracks_state ?? null,
    },
    netWorthLead: (nw(sb.radiant) - nw(sb.dire)) || 0,
    // straight from Valve: no waiting for OpenDota to parse game 1
    series: { a: g.radiant_series_wins ?? 0, b: g.dire_series_wins ?? 0 },
    bestOf: g.series_type === 1 ? 3 : g.series_type === 2 ? 5 : g.series_type === 0 ? 1 : null,
    roshanRespawnSec: sb.roshan_respawn_timer ?? null,
    streams: streamsFor(streams, a, b),
    stats: `https://www.opendota.com/matches/${g.match_id}`,
  };
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const cors = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=10",
  };
  try {
    // What does Valve actually send? Field NAMES only — useful for deciding what
    // is buildable without guessing, and it exposes no key and no match data.
    if (url.searchParams.get("fields") === "1") {
      const games = await valveLive(Number(url.searchParams.get("league") || 19719));
      const g = (games || [])[0];
      const sb = g?.scoreboard ?? {};
      const p = (sb.radiant?.players ?? [])[0] ?? {};
      return new Response(JSON.stringify({
        game: Object.keys(g ?? {}),
        scoreboard: Object.keys(sb),
        side: Object.keys(sb.radiant ?? {}),
        player: Object.keys(p),
        picksBans: Array.isArray(sb.radiant?.picks) ? Object.keys(sb.radiant.picks[0] ?? {}) : null,
      }, null, 1), { headers: cors });
    }

    /* The prize pool, straight from Valve.
       The updater scrapes this off a Liquipedia SUBPAGE with a regex, because
       the main page carries a transclusion rather than a number — it broke once
       already and showed the $1.6M base for hours. Valve returns the figure in
       one field. Exposed here rather than called from the updater directly, so
       the Steam key stays in one place instead of being copied into GitHub. */
    if (url.searchParams.get("prize") === "1") {
      const league = Number(url.searchParams.get("league") || 19719);
      if (!STEAM_KEY) return new Response(JSON.stringify({ error: "no key" }), { status: 503, headers: cors });
      const r = await fetch(
        `https://api.steampowered.com/IEconDOTA2_570/GetTournamentPrizePool/v1/?key=${encodeURIComponent(STEAM_KEY)}&leagueid=${league}`,
        { headers: UA });
      const j = await r.json().catch(() => null);
      const pool = j?.result?.prize_pool;
      if (typeof pool !== "number") {
        return new Response(JSON.stringify({ error: "unavailable" }), { status: 502, headers: cors });
      }
      return new Response(JSON.stringify({ leagueId: league, prizePool: pool }), {
        headers: { ...cors, "Cache-Control": "public, max-age=300" },
      });
    }

    /* A finished game, in full.
       The live feed only carries the six working item slots; once a match is
       parsed the other four exist — three backpack and the neutral — along with
       the final KDA, net worth, GPM and last hits. This is the only place those
       can come from, so the match detail view reads from here. */
    /* Every game of one series, by team names.
       The site thinks in fixtures ("gs-r2-m1") and pairings; Valve and OpenDota
       think in game ids. The league's own finished-game list already carries
       both, so resolve here rather than making the page hold a mapping it would
       only get stale. */
    const seriesParam = url.searchParams.get("series");
    if (seriesParam) {
      const [ta, tb] = seriesParam.split("|");
      if (!ta || !tb) return new Response(JSON.stringify({ error: "need series=A|B" }), { status: 400, headers: cors });
      const league = Number(url.searchParams.get("league") || 19719);
      const [gamesR, teamsR] = await Promise.all([
        fetch(`${OPENDOTA}/leagues/${league}/matches`, { headers: UA }).then(r => r.json()).catch(() => []),
        fetch(`${OPENDOTA}/leagues/${league}/teams`, { headers: UA }).then(r => r.json()).catch(() => []),
      ]);
      const tn: Record<string, string> = {};
      (teamsR || []).forEach((t: any) => { if (t.team_id && t.name) tn[String(t.team_id)] = t.name; });
      const want = [tkey(ta), tkey(tb)].sort().join("|");
      const games = (Array.isArray(gamesR) ? gamesR : [])
        .filter((g: any) => {
          const r = (g.radiant_name || tn[String(g.radiant_team_id)] || "").trim();
          const d = (g.dire_name || tn[String(g.dire_team_id)] || "").trim();
          return r && d && [tkey(r), tkey(d)].sort().join("|") === want;
        })
        .sort((a: any, b: any) => (a.start_time ?? 0) - (b.start_time ?? 0))
        .map((g: any, i: number) => ({
          matchId: String(g.match_id),
          game: i + 1,
          startTime: g.start_time ?? null,
          duration: g.duration ?? null,
          radiantWin: g.radiant_win ?? null,
          radiant: (g.radiant_name || tn[String(g.radiant_team_id)] || "").trim(),
          dire: (g.dire_name || tn[String(g.dire_team_id)] || "").trim(),
        }));
      return new Response(JSON.stringify({ series: `${ta} vs ${tb}`, games }, null, 1),
        { headers: { ...cors, "Cache-Control": "public, max-age=120" } });
    }

    const gameId = url.searchParams.get("game");
    if (gameId) {
      if (!/^\d{6,20}$/.test(gameId)) {
        return new Response(JSON.stringify({ error: "bad id" }), { status: 400, headers: cors });
      }
      const [heroMap, itemMap] = await Promise.all([heroes(), items()]);
      const r = await fetch(`${OPENDOTA}/matches/${gameId}`, { headers: UA });
      if (!r.ok) return new Response(JSON.stringify({ error: `upstream ${r.status}` }), { status: 502, headers: cors });
      const m = await r.json().catch(() => null);
      if (!m || !Array.isArray(m.players)) {
        return new Response(JSON.stringify({ error: "not parsed yet" }), { status: 404, headers: cors });
      }
      const it = (id: any) => {
        if (!id) return null;
        const x = itemMap[String(id)];
        return x ? { id, name: x.name, img: x.img } : { id, name: null, img: null };
      };
      const side = (radiant: boolean) => (m.players || [])
        .filter((p: any) => (p.isRadiant ?? (p.player_slot < 128)) === radiant)
        .map((p: any) => ({
          player: p.name || p.personaname || null,
          heroId: p.hero_id,
          hero: heroMap[String(p.hero_id)]?.name || null,
          img: heroMap[String(p.hero_id)]?.img || null,
          level: p.level ?? null,
          kills: p.kills ?? null, deaths: p.deaths ?? null, assists: p.assists ?? null,
          netWorth: p.net_worth ?? p.total_gold ?? null,
          gpm: p.gold_per_min ?? null, xpm: p.xp_per_min ?? null,
          lastHits: p.last_hits ?? null, denies: p.denies ?? null,
          items: [p.item_0, p.item_1, p.item_2, p.item_3, p.item_4, p.item_5].map(it),
          backpack: [p.backpack_0, p.backpack_1, p.backpack_2].map(it),
          neutral: it(p.item_neutral),
        }));
      return new Response(JSON.stringify({
        matchId: String(m.match_id),
        radiantWin: m.radiant_win,
        duration: m.duration ?? null,
        startTime: m.start_time ?? null,
        radiant: { name: m.radiant_team?.name || m.radiant_name || "Radiant", score: m.radiant_score ?? null, players: side(true) },
        dire:    { name: m.dire_team?.name    || m.dire_name    || "Dire",    score: m.dire_score ?? null,    players: side(false) },
      }, null, 1), { headers: { ...cors, "Cache-Control": "public, max-age=3600" } });
    }

    if (url.searchParams.get("streams") === "1") {
      return new Response(JSON.stringify({ streams: await resolveStreams() }, null, 1), { headers: cors });
    }

    const leagueParam = url.searchParams.get("league");
    const wanted = leagueParam ? Number(leagueParam) : 19719;
    // ?src=opendota forces the fallback path, so it can be exercised on demand
    // rather than only discovered broken the day Valve is down.
    const forceOD = url.searchParams.get("src") === "opendota";
    const [streams, heroMap, teamMap, itemMap, fin, valve, liveRaw] = await Promise.all([
      resolveStreams(),
      heroes(),
      teamLogos(wanted),
      items(),
      finished(wanted),
      forceOD ? Promise.resolve(null) : valveLive(wanted),
      fetch(`${OPENDOTA}/live`, { headers: UA }).then(r => r.json()).catch(() => []),
    ]);

    // Valve is the authority: it returns only games actually being played, so
    // none of the finished-game guesswork below is needed when it answers.
    if (valve && valve.length >= 0 && !forceOD) {
      const matches = valve
        .map((g: any) => shapeValve(g, heroMap, teamMap, itemMap, streams))
        .sort((x: any, y: any) => (x.gameMinute ?? 0) - (y.gameMinute ?? 0));
      const livePairs = new Set(matches.map((m: any) =>
        [tkey(m.radiant.name), tkey(m.dire.name)].sort().join("|")));
      const replays = streams.filter(s => s.teamA && s.teamB
        && !livePairs.has([tkey(s.teamA), tkey(s.teamB)].sort().join("|")));
      return new Response(JSON.stringify({
        matches, replays, streamsAll: streams, leagueId: wanted,
        source: "valve", updatedAt: new Date().toISOString(),
      }, null, 1), { headers: cors });
    }

    const now = Math.floor(Date.now() / 1000);
    const seen = new Map<string, any>();

    (Array.isArray(liveRaw) ? liveRaw : []).forEach((g: any) => {
      if (g.league_id !== wanted) return;
      const a = String(g.team_name_radiant || "").trim();
      const b = String(g.team_name_dire || "").trim();
      if (!a || !b) return;
      // Valve marks some ended games directly — cheapest and surest signal.
      if (g.deactivate_time) return;
      // This exact game is already parsed as finished.
      if (fin.ids.has(String(g.match_id))) return;
      const k = [tkey(a), tkey(b)].sort().join("|");
      // The whole series is settled, so nothing of it is still being played.
      if (fin.decided.has(k)) return;

      // The decisive test: is the clock actually moving?
      if (!isBeingPlayed(g, now)) return;

      const drafting = (g.game_time ?? 0) <= 0;
      // one row per pairing, newest match id wins
      const prev = seen.get(k);
      if (prev && Number(prev.matchId) >= Number(g.match_id)) return;

      const side = (t: number) => (g.players || [])
        .filter((p: any) => p.team === t)
        .map((p: any) => ({
          player: p.name || null,
          heroId: p.hero_id,
          hero: heroMap[String(p.hero_id)]?.name || null,
          img: heroMap[String(p.hero_id)]?.img || null,
          country: p.country_code || null,
          role: p.fantasy_role ?? null,
        }));

      seen.set(k, {
        matchId: String(g.match_id),
        seriesId: g.series_id ?? null,
        startedAgo: g.activate_time ? now - g.activate_time : null,
        gameMinute: g.game_time != null ? Math.floor(g.game_time / 60) : null,
        drafting,
        delaySec: g.delay ?? null,
        spectators: g.spectators ?? 0,
        radiant: {
          name: a, kills: g.radiant_score ?? 0, teamId: g.team_id_radiant ?? null,
          logo: teamMap[String(g.team_id_radiant)]?.logo ?? null,
          players: side(0),
        },
        dire: {
          name: b, kills: g.dire_score ?? 0, teamId: g.team_id_dire ?? null,
          logo: teamMap[String(g.team_id_dire)]?.logo ?? null,
          players: side(1),
        },
        // positive = radiant ahead, in gold
        netWorthLead: g.radiant_lead ?? null,
        // Series standing so far, from games already finished. Without it the
        // kill score reads like the whole result and an ongoing series looks
        // like a replay of something already decided.
        series: {
          a: (fin.wins[k] || {})[tkey(a)] || 0,
          b: (fin.wins[k] || {})[tkey(b)] || 0,
        },
        streams: streamsFor(streams, a, b),
        stats: `https://www.opendota.com/matches/${g.match_id}`,
      });
    });

    // Newest game first. Sorting by minute put the game that started most
    // recently — the one people are actually watching — at the BOTTOM, under
    // whatever had been running longest.
    const matches = [...seen.values()]
      .sort((x, y) => (x.startedAgo ?? 1e9) - (y.startedAgo ?? 1e9));
    /* Channels broadcasting something that has no live game behind it.
       Valve reruns finished series on the spare channels between rounds, and
       those look identical to a live broadcast from the outside — same channel,
       same title format. Listing them separately keeps the top of the page
       honest: "live" means a game server with a moving clock, nothing else. */
    const livePairs = new Set(matches.map((m: any) =>
      [tkey(m.radiant.name), tkey(m.dire.name)].sort().join("|")));
    const replays = streams.filter(s => {
      if (!s.teamA || !s.teamB) return false;
      return !livePairs.has([tkey(s.teamA), tkey(s.teamB)].sort().join("|"));
    });

    return new Response(JSON.stringify({
      matches,
      replays,
      streamsAll: streams,
      leagueId: wanted,
      updatedAt: new Date().toISOString(),
    }, null, 1), { headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e).slice(0, 300) }), { status: 500, headers: cors });
  }
});
