# 02 — Auto-Updating the Data (Liquipedia feed)

Goal: keep `data.json` current automatically — scores, standings, brackets,
team logos, rosters — so the live site stays up to date with no manual editing.

## How it works

A browser page can't fetch Liquipedia directly (CORS + rate limits), so:

1. A **GitHub Action** runs `update_data.py` on a schedule.
2. The script calls the **Liquipedia API**, parses the TI 2026 pages, and
   rewrites `data.json`.
3. If anything changed, the Action commits the new `data.json`.
4. GitHub Pages serves the new file; the open app picks it up within 30s
   (its Live & Upcoming rail polls; other sections update on the next load).

```
GitHub Action (cron)  ─run─▶  update_data.py  ─HTTP─▶  Liquipedia API
        │                           │
        │                     writes data.json
        └────────── git commit & push ──────────▶  repo → Pages → browser
```

## Setup

1. The workflow file is already at `.github/workflows/update.yml`. It runs every
   3 hours and is also runnable on demand (Actions tab → Run workflow).
2. **Set your contact** (Liquipedia requires it in the request User-Agent):
   - Edit `CONTACT` near the top of `update_data.py`, **or**
   - Add a repo variable: Settings → Secrets and variables → Actions →
     **Variables** → `LIQUIPEDIA_CONTACT` = your email or site URL.
3. Make sure the workflow has push permission: it already declares
   `permissions: contents: write`. If your org restricts this, enable
   "Read and write permissions" under Settings → Actions → General →
   Workflow permissions.
4. Open the **Actions** tab → *Update TI 2026 data* → **Run workflow** to test.

During the live event you can lower the cron interval (e.g. every 30 min), but
**stay polite to Liquipedia** — don't poll more often than ~30 min.

## What the script already does

`update_data.py` reliably parses and writes:

- **Prize pool** total + distribution.
- **Qualifier winners** per region.
- **Team list**, and resolves each team's **official logo URL** from Liquipedia
  (writes `logo` on each team + a top-level `logos` map). See
  [05-DATA-SCHEMA.md](05-DATA-SCHEMA.md).

It's defensive: if Liquipedia is unreachable or a section can't be parsed, it
keeps existing data and exits cleanly (never wipes good data).

## What still needs parser work

Three things use Liquipedia's "Match2" storage on **subpages**, which is more
involved to parse than the main page wikitext. The script has documented hooks
and the exact JSON shapes to write into; you (or a later pass) implement the
parsing against the subpages:

1. **Group-stage standings** → `groupStage.standings`
   (subpage: `The_International/2026/Group_Stage`).
2. **Playoff bracket** → `bracket.rounds.upper/lower` + `bracket.grandFinal`
   (subpage: `The_International/2026` main event section).
3. **Per-region matches** → `qualifiers[].matches`
   (each regional qualifier subpage).
4. **Rosters/coaches** → `teams[].players` / `teams[].coach`
   (each team page).

### How to implement a Match2 parser (outline)

Liquipedia stores matches via `{{Match}}`/`Match2` templates and exposes them
through the **`matchlist`/`bracket` LPDB tables** via the API's
`action=query&list=...` or the dedicated `matchlist` endpoints. Two routes:

- **Wikitext route (simplest, brittle):** fetch the subpage wikitext (the script
  already has `get_wikitext`), regex out `{{Match|...|opponent1=...|score1=...}}`
  blocks, and map them into the JSON shapes. Good enough for a stable bracket.
- **LPDB route (robust):** query Liquipedia's Match2 data store
  (`action=query` with the `match2` props, or the `matchlist` API) to get
  structured opponents/scores/status. More reliable across layout changes.
  See Liquipedia's API docs for the Match2 schema.

Write results into the documented shapes and the front end renders them with
zero UI changes — it already handles `completed` / `live` / `upcoming` states,
logos, and rosters.

## Manual fallback (no script needed)

Until the parsers are done, you can edit `data.json` by hand and commit it; the
site updates the same way. The data schema is in
[05-DATA-SCHEMA.md](05-DATA-SCHEMA.md). (The in-app JSON editor was removed from
the toolbar when "Create League" replaced it, but the data file is the single
source of truth and editing it directly always works.)

## Liquipedia etiquette (required)

- Descriptive User-Agent with contact info (the script does this).
- Rate limit: ≤ 1 request / 2 s for parse/HTML actions (the script throttles).
- Data is **CC-BY-SA** — keep the footer attribution. See
  https://liquipedia.net/api-terms-of-use.

## Second source: OpenDota (live match results)

The updater also pulls live match **results** from **OpenDota** — a real
REST/JSON API (https://docs.opendota.com), free up to 50k calls/month and 60
requests/min. This is a separate, independent source from Liquipedia:

- **Liquipedia** stays authoritative for tournament *structure* — prize ladder,
  bracket shape, qualifiers, logos, rosters.
- **OpenDota** backfills/confirms the actual *scores*, so the site keeps
  updating even between Liquipedia parses or if Liquipedia is briefly down.

### How it works in the script

1. `fetch_opendota_results()` calls `/leagues/{id}/matches`, which returns one
   row per game; the script aggregates games into series scores per team pair.
2. `merge_opendota_scores()` matches those series to your bracket/qualifier
   matches by team names and fills in `teamA.score` / `teamB.score`, flipping
   a match to `completed` once a side clinches the Bo-N.
3. It runs in the normal flow *and* in the Liquipedia-outage fallback, so
   results refresh independently.

### Setup

Set the TI 2026 OpenDota **league id** (the only required piece):

- Repo variable: Settings → Secrets and variables → Actions → Variables →
  `OPENDOTA_LEAGUE_ID` = the numeric id (find it via OpenDota's `/leagues`
  endpoint or the league's OpenDota page URL), **or**
- Edit `OPENDOTA_LEAGUE_ID` near the top of `update_data.py`.
- Optional: `OPENDOTA_API_KEY` for higher rate limits (not needed for a
  3-hourly job).

Until the league id is set, the OpenDota step **skips cleanly** and the script
behaves exactly as before (Liquipedia only). No errors, no empty data.

### Why two sources

Redundancy: if one feed is unavailable, the other still updates the site. And
each plays to its strength — Liquipedia for structure, OpenDota for a clean,
pollable results API that doesn't require scraping a wiki. Team-name matching is
how the two are joined, so keep team names consistent (the front end's logo map
also keys on names).

Next: [03-AUTH-AND-EMAIL.md](03-AUTH-AND-EMAIL.md).
