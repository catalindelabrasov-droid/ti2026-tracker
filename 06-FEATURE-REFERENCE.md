# 06 — Feature & Front-End Reference

A map of everything built, where its state lives, and the exact place in
`index.html` a backend swaps in. Use this as the checklist when wiring things up.

## localStorage keys (what becomes a backend)

| Key | Holds | Backend doc |
|-----|-------|-------------|
| `ti2026_user` | signed-in user `{username, email, name}` | 03 |
| `ti2026_league` | the whole league (members, rules, predictions) | 04 |
| `ti2026_notif_ids` | match ids the user wants alerts for | stays local (fine) |
| `ti2026_seen_scores` | baseline for change detection | stays local |
| `ti2026_region_view` | Popup vs Page preference | stays local |
| `ti2026_data_override` | manual JSON edit override (dev) | stays local |

Only the first two need a backend. The rest are per-device preferences and can
stay in `localStorage`.

## Feature → status → where it lives

| Feature | Works now | Needs backend | Code location |
|---------|-----------|---------------|---------------|
| Countdown to event | ✅ fully | — | `startCountdown()` |
| Prize pool ladder | ✅ from data | — | `renderPrize()` |
| Qualifiers + region detail | ✅ from data | — | `renderQualifiers()`, `regionDetailHTML()` |
| Teams + rosters/coach | ✅ from data | — | `renderTeams()`, `teamDetailHTML()` |
| Group stage | ✅ from data | — | `renderGroups()` |
| Bracket | ✅ from data | — | `renderBracket()`, `bracketMatch()` |
| Team logos | ✅ (badge fallback) | data feed for real logos | `teamLogo()` |
| Live & Upcoming auto-refresh | ✅ polls data.json | — | `setupAutoRefresh()`, `refreshNow()` |
| Notifications | ✅ while page open | (push needs a service worker) | `toggleNotif()`, `checkForResultChanges()` |
| Search / filters / watch links | ✅ fully | — | `applySearchFilter()`, `watchButton()` |
| Sign in / sign up | UI + validation only | **auth + email (03)** | `wireAuth()` |
| Confirmation email | template ready | **email send (03)** | `email_confirmation_template.html` |
| Prediction League | local + seeded friends | **league backend (04)** | the `lg*` functions |
| 43-rule scoring config | ✅ toggles + points save | scoring math per kept rule (04) | `lgRulesView()`, `DEFAULT_RULES` |

## Auth swap points (doc 03)

`wireAuth()` → `#signupSubmit` and `#signinSubmit` handlers. Keep
`validateSignup()`/`validateSignin()`; replace the local-store calls with your
auth provider. `handleConfirmationLanding()` already handles the `?confirmed=1`
return from the email link. `renderAuthArea()` draws the signed-in chip / the
Sign in–Sign up buttons.

## League swap points (doc 04)

- `lgLoad()` / `lgSave()` — replace localStorage with API calls.
- `lgSeedOthers()` — delete (was demo-only).
- Create/join/lock handlers in `wireLeaguePanel()`.
- `lgOthersBlock()` — enforce reveal-after-lock via the API.
- `lgComputeLeaderboard()` — mirror server-side; the function shows the base
  winner + exact-score math to extend.

## Rules object

`DEFAULT_RULES` in `index.html` is the full schema (43 rules). Each is
`{on: bool, pts: number}` except side-game mechanics (`{on}` only) and
`scoreMode` (`"flat" | "weighted" | "odds"`). When you finalize which rules to
keep, the league backend implements scoring for exactly those.

## Build variants (for your own testing)

- `index.html` — the real app (deploy this).
- `preview_standalone.html` — demo data baked in; offline preview.
- `test_no_login.html` — same, but auto-signs in a demo user so the league is
  reachable without auth. **Don't deploy this one** (it bypasses login).

To regenerate the previews after editing `index.html`, re-inline `data.demo.json`
(the build steps are simple string injections; see the project history or just
keep editing `index.html` and re-export).
