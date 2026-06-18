# The International 2026 — Results Tracker

A self-hosted web app that tracks **TI 2026 (TI 15)** in Shanghai — prize pool,
regional qualifiers, teams, group stage, and the playoff bracket. It can keep
itself up to date via a scheduled job, and it includes search, filters, a
live/upcoming match rail, match notifications, team rosters, and a friends'
prediction league.

> **Ready to deploy?** The full deployment documentation is in **`docs/`**.
> Start with [`docs/00-DEPLOYMENT-GUIDE.md`](docs/00-DEPLOYMENT-GUIDE.md), which
> covers hosting, the data auto-update feed, the auth+email backend, and the
> league backend — everything needed to take the local/demo features live.

## Features

- **Live & Upcoming rail** — live matches (with a pulsing indicator) and the
  next scheduled games, sorted so live shows first.
- **Search** — filter teams across every section by name.
- **Filters** — All / Live / Upcoming.
- **Full group standings** — Swiss table with Advances / Out status.
- **Double-elimination bracket** — Upper, Lower, and Grand Final, with winners
  highlighted and Bo3/Bo5 labels.
- **Match notifications** — tap the 🔔 on any match to be alerted when its
  result lands. While the page is open it shows an in-app toast and a browser
  notification (if you allow them). Your picks are saved in your browser.
- **Built-in editor** — the ✎ Edit button opens a JSON editor to add or fix
  results by hand, preview instantly, and export an updated `data.json`.

## Files

| File | Purpose |
|------|---------|
| `index.html` | The whole app (HTML + CSS + JS in one file). Reads `data.json`. |
| `data.json` | Live tournament data. The app renders whatever's in here. |
| `data.demo.json` | Sample filled-in data to preview every feature (optional). |
| `update_data.py` | Fetches fresh data from Liquipedia and rewrites `data.json`. |
| `.github/workflows/update.yml` | Runs the updater on a schedule and commits changes. |

## Two ways to keep results current

**A. Automatic (recommended once you're ready).** A GitHub Action runs
`update_data.py` on a schedule; it pulls from the Liquipedia API and commits an
updated `data.json`. Your hosted page always loads the latest. Setup is in the
section below.

**B. Manual, in the browser.** Click **✎ Edit**, paste or adjust the JSON,
hit **Apply** to preview, then **Download data.json** and commit that file to
your repo. Good for filling results before the auto-update is wired up. (Browser
edits save locally only — they can't write back to the hosted file, so export
and commit to share them.)

## Preview with demo data

To see every feature populated, copy the sample over the live file:
```bash
cp data.demo.json data.json   # preview
# ...restore the real one when done:
git checkout data.json
```
The demo file shows a clearly-labelled banner so it's never mistaken for real
results.

## Setup for automatic updates (~5 min)

1. **Put these files in a GitHub repo** (keep the folder structure, including
   `.github/workflows/update.yml`).
2. **Set your contact info** (Liquipedia requires it in the request
   User-Agent). Edit `CONTACT` near the top of `update_data.py`, *or* add a repo
   variable: Settings → Secrets and variables → Actions → **Variables** →
   `LIQUIPEDIA_CONTACT` = your email or site URL.
3. **Enable the job.** Actions tab → enable workflows → open *Update TI 2026
   data* → **Run workflow** to test once. It then runs every 3 hours.
4. **Host with GitHub Pages.** Settings → **Pages** → Deploy from branch →
   `main` / root. Live at `https://<user>.github.io/<repo>/`.

## Running locally
Browsers block `fetch` on `file://`, so use a tiny server:
```bash
python3 -m http.server 8000
# open http://localhost:8000
```
Refresh data by hand:
```bash
LIQUIPEDIA_CONTACT="you@example.com" python3 update_data.py
```

## Data shape (for the auto-updater)
`update_data.py` reliably pulls prize pool, prize distribution, qualifier
winners, and the team list. Group standings and the full bracket use
Liquipedia's Match2 system and aren't parsed yet — the script documents the
exact JSON shapes to write into (`groupStage.standings`,
`bracket.rounds.upper/lower`, `bracket.grandFinal`) so the front end renders
them, plus the `status` values (`completed` / `live` / `upcoming`) the UI
understands. Match `id`s must stay stable so notifications fire correctly.

## About notifications
This is a static site, so notifications work **while the page is open** (it
re-checks `data.json` every 60s and alerts on changes to matches you've
starred). True background push — alerts when the tab is closed — needs a
service worker plus a push server, which is beyond a static host. The code is
structured so you can add that later.

## Attribution & terms
Tournament data comes from **Liquipedia**, licensed **CC-BY-SA** (credited in
the footer). Fan project, not affiliated with Valve. Respect Liquipedia's
[API terms](https://liquipedia.net/api-terms-of-use).
