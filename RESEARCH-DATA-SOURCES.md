# Free Dota 2 data sources — verified research (2026-07-26)

Research for reorganizing the Teams / Tournaments / Players sections with real
rankings. Everything below was verified with live calls on 2026-07-26.

## Summary table

| Source | Teams | Players | Tournaments | Rankings | Logos | Auth | Free limits | Format | Legal for a fan site |
|---|---|---|---|---|---|---|---|---|---|
| **OpenDota** (in use) | Yes | Yes (pro roster+roles) | Partial (weak tiers) | Team Elo (noisy) | Yes (`logo_url`) | None (optional key) | **60/min, 3,000/day** (verified via response headers) | REST JSON | Yes; no restrictive ToS, credit appreciated |
| **STRATZ** | Yes | Yes (ranks, positions 1–5) | Yes (Valve-style tiers) | Player medals/leaderboards | Yes | **Token required** (free, Steam login) | 20/s, 250/min, 2,000/h, **10,000/day** | GraphQL | Yes; brand attribution expected ("Powered by STRATZ") |
| **Steam Web API** (official) | Weak | No rankings | Match/live data only | No | No | Free key | 100,000/day (per API ToS) | REST JSON | Yes; Valve API terms, as-is |
| **Valve keyless webapi** (undocumented) | — | **Official ladder top-5000/region, hourly** | **All 9,754 leagues: tier, prize, dates** | Ladder only | No | **None** | None published | JSON | Tolerated (powers dota2.com) but unsupported — could change anytime |
| **Liquipedia** (in use) | Yes (rosters) | Yes | **Best tier authority (Tier 1/2/3)** | ESL Pro Tour leaderboard pages | Yes | UA header; LPDB needs approved key | MediaWiki: 1 req/2s, parse 1/30s; **LPDB: 60 req/h** | MediaWiki JSON / LPDB REST | Yes, **CC-BY-SA 3.0 attribution mandatory**; HTML scraping explicitly banned |
| **Datdota** | **Glicko-2 + Elo team ratings, fresh** | Yes | **Curated leagues w/ own PREMIUM/PROFESSIONAL tiers** | Yes | No | None for main endpoints | ≥3s between requests (their terms) | REST JSON | Yes; community project, courtesy attribution, no SLA |
| **GosuGamers** | Rankings page only | — | — | Yes (still live 2026) | — | No API | — | HTML only | **No — ToS (Oct 2025) explicitly bans scraping**. Link only |
| **Dota2ProTracker** | No | High-MMR pub meta only | No | Hero ELO by position | — | No official API | — | — | Skip; wrong data shape |
| **PandaScore** | Yes | Yes | Yes | Partial | Yes | Free key | 1,000 req/h free plan | REST JSON | Yes, attribution; adds a new dependency |

## Key findings

### OpenDota (backbone — already in use)
- Free tier verified: **60 calls/min, 3,000 calls/day** without a key (headers
  `X-Rate-Limit-Remaining-Minute/Day`); with key 300/min.
- `/api/teams` is already sorted by Elo `rating` — BUT raw Elo puts
  match-volume grinders (e.g. "TEAM VISION") above real top teams. Don't rank
  by it alone; a Dota-literate audience will notice.
- `/api/proPlayers`: `account_id, name, avatar, country_code, fantasy_role`
  (1=core, 2=support), `team_id/team_name/team_tag`, fresh timestamps.
- `/api/rankings` is per-HERO player scores — not a global pro ranking.
- `/api/leagues` tiers are only `premium|professional|excluded` — too weak for
  a Tournaments page by itself (EWC 2026 and BLAST SLAM are just "professional").

### Datdota (the hidden gem for team ranks — free JSON, no key)
- `GET https://api.datdota.com/api/ratings` — per-team **Glicko-2 + Elo**,
  fresh, keyed by the same Valve `team_id` as OpenDota → joins cleanly with
  OpenDota logos.
- `GET https://api.datdota.com/api/leagues` — curated pro leagues with their
  own tier labels (EWC 2026 = `PREMIUM`), junk filtered out.
- Terms: **min 3 seconds between requests**; credit datdota; cache everything.

### Liquipedia (already in use)
- The only party still curating REAL tournament tiers (Tier 1/2/3) post-DPC.
- Rules verified: API only (HTML scraping explicitly banned), 1 req/2s
  (parse: 1/30s), custom User-Agent with contact, CC-BY-SA attribution with
  link. **LPDB structured API**: apply for a free personal key, 60 req/h.

### Valve
- Official Steam Web API (free key, 100k/day): live games + prize pool only.
- **Keyless endpoints (verified working, undocumented — fail-soft + cache):**
  - `https://www.dota2.com/webapi/IDOTA2League/GetLeagueInfoList/v001` — all
    leagues with tier/prize/dates. Tier-1 prize values are self-reported junk;
    trust prize only for curated events.
  - `https://www.dota2.com/webapi/ILeaderboard/GetDivisionLeaderboard/v0001?division=europe&leaderboard=0`
    — official ranked ladder top players per region, refreshed hourly
    (divisions: europe, americas, se_asia, china).

### STRATZ (optional enrichment)
- GraphQL, free "Default" token via Steam login: 10,000/day. Adds player rank
  medals, true positions 1–5, league standings. Show "Powered by STRATZ".

## Recommended architecture (least maintenance)

One scheduled sync (extend the existing GitHub Action or a Netlify function) →
fetch → normalize into Supabase tables → the site reads only Supabase.
~10–20 external calls/day, far inside every free tier.

- **(a) Ranked Teams:** order by datdota Glicko-2, join OpenDota `/teams` on
  `team_id` for name/tag/logo/W-L; filter to teams active in last ~90 days.
- **(b) Tournaments:** tier from Liquipedia (apply for LPDB key); dates/activity
  from datdota `/leagues` + Valve `GetLeagueInfoList`; prize from Liquipedia;
  results from OpenDota `/leagues/{id}/matches` (league ids are shared).
- **(c) Ranked Players:** OpenDota `/proPlayers` grouped by role, ordered by
  their team's rank from (a). Optional: Valve ladder widget (hourly official
  ranks) + STRATZ medals.

## Legal red lines
- Never scrape GosuGamers, Dotabuff, or dota2protracker (ToS violations) —
  link out at most.
- Liquipedia: API only, rate limits, CC-BY-SA credit with source links.
- Datdota: ≥3s spacing, credit them.
- Footer credits: OpenDota, Liquipedia (CC-BY-SA), datdota, STRATZ if used,
  "Dota 2 is a trademark of Valve Corporation."
