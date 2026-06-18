# TI 2026 Tracker — Deployment Guide

This is the master guide for taking the tracker from the local/demo build to a
live, hosted, fully-functional site. It links out to focused docs for each
backend piece.

## What you have today (front end, done)

A single-page app (`index.html`) that already implements, on the front end:

- Live tracker: countdown, prize-pool ladder, qualifiers, teams, group stage,
  double-elimination bracket, team logos, clickable team rosters/coaches,
  clickable region detail (popup + page).
- Live & Upcoming rail that auto-refreshes from `data.json` every 30s.
- Match notifications, search, filters, watch links.
- Sign in / sign up UI with validation + confirmation-email flow.
- Prediction League: create/join, predictions (match + tournament outcomes),
  lock rules, leaderboard, and a 43-rule configurable scoring system.

Everything reads from data files and `localStorage`. Nothing yet talks to a
real server. The whole point of deployment is to connect three backends:

1. **Data feed** — auto-update `data.json` from Liquipedia (script already written).
2. **Auth + email** — real accounts, password security, confirmation emails.
3. **League backend** — shared leagues, predictions, and leaderboards across devices.

## The four steps (in recommended order)

| Step | What it unlocks | Doc | Effort |
|------|-----------------|-----|--------|
| 1. Host the static site | A public URL; the live tracker works | [01-HOSTING.md](01-HOSTING.md) | ~15 min |
| 2. Auto-update data | Real scores/standings/logos, hands-off | [02-DATA-AUTOUPDATE.md](02-DATA-AUTOUPDATE.md) | ~30 min + parser work |
| 3. Auth + email | Real sign-up, login, confirmation emails | [03-AUTH-AND-EMAIL.md](03-AUTH-AND-EMAIL.md) | ~half day |
| 4. League backend | Shared leagues/leaderboards for friends | [04-LEAGUE-BACKEND.md](04-LEAGUE-BACKEND.md) | ~1–2 days |

You can stop after any step — each adds capability independently. Step 1 alone
gives you a working public tracker. Steps 3 and 4 are what turn the
accounts/league from "local only" into "real and shared."

## Recommended stack (one cohesive choice)

The simplest path that covers steps 3 and 4 together is **Supabase** (hosted
Postgres + auth + email + APIs) plus **GitHub Pages** (free static hosting) and
a **GitHub Action** (free scheduled job for the data feed). This guide is
written around that stack, but the data files and front-end contracts are
generic, so Firebase, Auth0, Pocketbase, or a small custom Node/Express +
Postgres server all work too. See each doc for alternatives.

```
                        ┌──────────────────────┐
   GitHub Action  ─────▶│  data.json (in repo) │◀──── GitHub Pages serves it
   (every 3h)           └──────────────────────┘            │
        │                                                   ▼
        │ Liquipedia API                            ┌──────────────┐
        └──────────────────────────────────────────│  index.html  │
                                                     │  (browser)  │
                                                     └──────┬───────┘
                                          auth + league API │
                                                     ┌──────▼───────┐
                                                     │   Supabase    │
                                                     │ auth · db ·   │
                                                     │ email · REST  │
                                                     └───────────────┘
```

## Files in this project

| File | Role |
|------|------|
| `index.html` | The app. Deploy this. |
| `data.json` | Live tournament data the app reads. Auto-updated. |
| `data.demo.json` | Sample data for previewing (not deployed). |
| `update_data.py` | Fetches from Liquipedia, writes `data.json`. |
| `.github/workflows/update.yml` | Runs the updater on a schedule. |
| `email_confirmation_template.html` | The sign-up confirmation email. |
| `preview_standalone.html` | Offline preview with demo data baked in. |
| `test_no_login.html` | Preview with login bypassed for testing. |
| `docs/` | These guides. |

> When you deploy, you host `index.html` + `data.json` (and the assets it
> fetches). The `preview_*` and `test_*` files are for your own local viewing
> and don't need to go live.

## Front-end ↔ backend contracts (quick reference)

These are the touch-points where the front end currently uses `localStorage`
and will instead call your backend. Each is detailed in its doc.

- **Auth**: the app stores the signed-in user at `localStorage["ti2026_user"]`
  as `{username, email, name}`. Replace the stubbed submit handlers in
  `wireAuth()` with real calls; on success, store the returned session.
  (See 03.)
- **League**: the app stores the whole league at
  `localStorage["ti2026_league"]`. Replace `lgLoad()` / `lgSave()` and the
  seeding with API calls. (See 04.)
- **Data**: the app fetches `data.json`. No change needed — just make sure the
  hosted file is the one the updater writes. (See 02.)

## Security & cost notes

- GitHub Pages, GitHub Actions (public repo), and Supabase all have free tiers
  that comfortably cover a friends-group league.
- Never put secrets (API keys, service-role keys, SMTP passwords) in
  `index.html` or any committed file. They live in GitHub Action secrets or
  Supabase's dashboard. The browser only ever uses Supabase's public "anon" key,
  which is safe to expose when Row-Level Security is on (see 04).
- Liquipedia data is CC-BY-SA; keep the footer attribution.

Start with [01-HOSTING.md](01-HOSTING.md).
