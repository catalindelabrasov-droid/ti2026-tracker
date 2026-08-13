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
const tkey = (s: unknown) =>
  norm(s).replace(/[.\-_'"]/g, " ")
    .replace(/\b(gaming|esports?|e-sports|club|team|the|ti|20\d\d)\b/g, " ")
    .replace(/\s+/g, " ").trim();

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

// A game that has ended can linger in /live for a long time, so staleness is the
// only usable signal. Same thresholds the main feed settled on.
const STALE_RUNNING = 6 * 60, STALE_DRAFT = 25 * 60;

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
    const [streams, heroMap, teamMap, liveRaw] = await Promise.all([
      resolveStreams(),
      heroes(),
      teamLogos(wanted),
      fetch(`${OPENDOTA}/live`, { headers: UA }).then(r => r.json()).catch(() => []),
    ]);

    const now = Math.floor(Date.now() / 1000);
    const seen = new Map<string, any>();

    (Array.isArray(liveRaw) ? liveRaw : []).forEach((g: any) => {
      if (g.league_id !== wanted) return;
      const a = String(g.team_name_radiant || "").trim();
      const b = String(g.team_name_dire || "").trim();
      if (!a || !b) return;
      const drafting = (g.game_time ?? 0) <= 0;
      const age = g.last_update_time ? now - g.last_update_time : 1e9;
      if (age > (drafting ? STALE_DRAFT : STALE_RUNNING)) return;
      // one row per pairing, newest match id wins
      const k = [tkey(a), tkey(b)].sort().join("|");
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
        streams: streamsFor(streams, a, b),
        stats: `https://www.opendota.com/matches/${g.match_id}`,
      });
    });

    const matches = [...seen.values()].sort((x, y) => (y.gameMinute ?? 0) - (x.gameMinute ?? 0));
    return new Response(JSON.stringify({
      matches,
      streamsAll: streams,
      leagueId: wanted,
      updatedAt: new Date().toISOString(),
    }, null, 1), { headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e).slice(0, 300) }), { status: 500, headers: cors });
  }
});
