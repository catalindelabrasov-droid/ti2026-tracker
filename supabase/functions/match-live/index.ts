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
//   STRATZ_TOKEN returns 403 no matter what. Valve's GetLiveLeagueGames would
//   give per-player net worth, items, towers and roshan, but needs a Steam Web
//   API key we do not have yet.
//   OpenDota's /live needs no credentials and already carries the two things
//   that matter most — radiant_lead (net worth swing) and the full draft with
//   pro player names — so v1 is built on that.
//
// The stream half needs no credentials either: Twitch's public channel page
// carries isLiveBroadcast and a description naming the teams, e.g.
// "[EN-C] Aurora Gaming vs. GamerLegion - The International 2026 - Group Stage".
// That is scraping, so it is cached hard and degrades to "this channel is live
// but we could not read its title" rather than failing.

const OPENDOTA = "https://api.opendota.com/api";
const UA = { "User-Agent": "dota2tileague/1.0 (https://dota2tileague.com)" };

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

async function resolveStreams() {
  if (_streams && Date.now() - _streams.at < STREAM_TTL) return _streams.data;
  const out = await Promise.all(CHANNELS.map(async ({ c, lang }) => {
    try {
      const r = await fetch(`https://www.twitch.tv/${c}`, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; dota2tileague/1.0)" },
      });
      if (!r.ok) return null;
      const h = await r.text();
      if (!/isLiveBroadcast/.test(h)) return null;
      const desc = (h.match(/<meta name="description" content="([^"]{0,200})"/) || [])[1] || "";
      const m = desc.match(/\[[A-Z]{2}[-\s]?[A-Z]?\]\s*(.+?)\s+vs\.?\s+(.+?)\s*[-|]/i);
      return {
        channel: c, lang, url: `https://www.twitch.tv/${c}`,
        title: desc.replace(/\s+/g, " ").trim().slice(0, 160),
        teamA: m ? m[1].trim() : null,
        teamB: m ? m[2].trim() : null,
      };
    } catch (_e) { return null; }
  }));
  const data = out.filter(Boolean) as any[];
  _streams = { at: Date.now(), data };
  return data;
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

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const cors = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=10",
  };
  try {
    if (url.searchParams.get("streams") === "1") {
      return new Response(JSON.stringify({ streams: await resolveStreams() }, null, 1), { headers: cors });
    }

    const leagueParam = url.searchParams.get("league");
    const wanted = leagueParam ? Number(leagueParam) : 19719;
    const [streams, heroMap, teamMap, fin, liveRaw] = await Promise.all([
      resolveStreams(),
      heroes(),
      teamLogos(wanted),
      finished(wanted),
      fetch(`${OPENDOTA}/live`, { headers: UA }).then(r => r.json()).catch(() => []),
    ]);

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
