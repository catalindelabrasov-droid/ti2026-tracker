# 04 — League Backend (shared predictions + leaderboard)

Goal: turn the Prediction League from "works on my device only" into a real
shared game — friends on their own phones join the same league, predictions are
stored centrally, and everyone sees the same leaderboard that updates after each
result.

## Why a backend is required

Today the whole league lives in `localStorage["ti2026_league"]`, and the "other
players" are seeded fakes. For a genuinely shared league you need server storage
for: leagues, members, predictions, and computed scores — plus the rule that you
can only see others' picks for a match after you've locked your own (which must
be enforced server-side so it can't be bypassed).

## Data model

Four tables (shown as Postgres / Supabase, but any DB works):

```
leagues
  id            uuid pk
  name          text
  code          text unique         -- the join code (emailed to creator)
  admin_id      uuid -> users
  rules         jsonb               -- the full rules object from the app
  created_at    timestamptz

league_members
  league_id     uuid -> leagues
  user_id       uuid -> users
  username      text                -- denormalized for display
  joined_at     timestamptz
  primary key (league_id, user_id)

predictions
  id            uuid pk
  league_id     uuid -> leagues
  user_id       uuid -> users
  match_id      text                -- matches data.json match ids
  pick          text                -- predicted winner name
  score_a       int
  score_b       int
  locked        bool
  locked_at     timestamptz
  unique (league_id, user_id, match_id)

outcome_predictions          -- champion, top4, etc.
  id            uuid pk
  league_id     uuid -> leagues
  user_id       uuid -> users
  kind          text             -- 'champion' | 'topFour' | ...
  value         jsonb            -- e.g. "Team Falcons" or ["A","B","C","D"]
  locked        bool
```

## The key API endpoints

| Action | Endpoint | Notes |
|--------|----------|-------|
| Create league | `POST /leagues` | generates code, emails it to creator, adds them as admin member |
| Join league | `POST /leagues/join` | body: `{code}`; uses caller's username; rejects dup |
| Get my league | `GET /leagues/mine` | returns league + members + rules |
| Lock prediction | `POST /predictions` | server stamps `locked_at`, enforces deadline |
| List match predictions | `GET /predictions?match=ID` | **only returns others' picks if caller has locked that match** |
| Leaderboard | `GET /leagues/:id/leaderboard` | server computes from locked predictions vs results |

### Two server-enforced rules (don't trust the client)

1. **Lock deadline**: reject a lock if `now > matchStart - rules.lockLeadMs`.
   The client also checks, but the server is the source of truth.
2. **Reveal-after-lock**: `GET /predictions?match=ID` must return other players'
   picks **only** if the caller has a locked prediction for that match.
   Otherwise return just the caller's own.

## Scoring

Run scoring server-side whenever a match finishes (the data feed updates
results). For each finished match, for each member's locked prediction:

- correct winner → `+rules.winner.pts`
- exact score → `+rules.exactScore.pts`
- (other enabled rules → their points; see the rules object)

Tournament-outcome bonuses (champion, top 4, …) resolve when the event ends.
Store a running `points` per member or compute on read — either is fine for a
friends-group size. The front end's `lgComputeLeaderboard()` shows the exact
base logic to mirror (winner + exact score); extend for whichever of the 43
rules you keep.

> Tip: decide your final rule set first (you have 43 toggles to choose from),
> then implement scoring for exactly those. Several rules need extra data:
> *upset bonus* needs seeds, *region performance* needs a region-scoring
> definition, *streak/percentile* need cross-match aggregation. Build only what
> you enable.

## With Supabase specifically

- Put the four tables in Postgres. Enable **Row-Level Security** so a user can
  only read/write their own predictions and leagues they belong to. RLS is what
  makes it safe to call the DB directly from the browser with the anon key.
- The "reveal-after-lock" rule is best done as a **Postgres function / RPC**
  (`get_match_predictions(match_id)`) that checks the caller's lock status
  before returning others' rows — RLS alone can't express "only if you've
  locked."
- Emailing the join code on create: a small **Edge Function** (or Supabase's
  built-in email) triggered on league creation.

## Front-end wiring (what to replace)

The league code is self-contained. Replace these in `index.html`:

- `lgLoad()` / `lgSave()` → fetch/POST to your API instead of `localStorage`.
- `lgSeedOthers()` → delete (real members/predictions come from the API).
- Create handler (`#lgCreateBtn`) → `POST /leagues`, show the returned code.
- Join handler (`#lgJoinBtn`) → `POST /leagues/join`.
- Lock handlers (match + champion + top4) → `POST /predictions`.
- `lgOthersBlock()` → call `GET /predictions?match=ID` (returns others only if
  you've locked).
- `lgComputeLeaderboard()` → call `GET /leagues/:id/leaderboard` (or keep
  computing client-side from an API that returns all locked predictions + results).
- The auto-refresh already re-renders the open league view every 30s; point it
  at the leaderboard endpoint and it stays live after each result.

Member display name = the account username (already enforced in the UI).

## Alternatives

- **Firebase (Firestore + Functions)** — same shape; security rules instead of
  RLS; Functions for email + reveal-after-lock logic.
- **Pocketbase** — single-binary backend (SQLite + auth + rules), easy to
  self-host, great for a small group.
- **Custom Node/Express + Postgres** — most control; you write the endpoints,
  the RLS-equivalent checks, and the email send yourself.

Next: [05-DATA-SCHEMA.md](05-DATA-SCHEMA.md) for the exact `data.json` shape.
