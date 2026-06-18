# 05 — data.json Schema Reference

The single source of truth the app reads. The auto-updater writes it; you can
also edit it by hand. Every field the front end uses is listed here. Anything
the updater can't fill yet shows a tidy "Not started" / placeholder state.

## Top-level shape

```json
{
  "meta": { ... },
  "prizePool": { ... },
  "qualifiers": [ ... ],
  "teams": [ ... ],
  "logos": { "Team Name": "https://logo-url" },
  "groupStage": { ... },
  "bracket": { ... }
}
```

## meta

```json
"meta": {
  "title": "The International 2026",
  "year": "2026",
  "shortName": "TI 15",
  "edition": 15,
  "location": "Shanghai, China",
  "venue": "Oriental Sports Center",
  "basePrizePool": 1600000,
  "teamCount": 16,
  "dates": {
    "groupStage": "2026-08-13 to 2026-08-16",
    "mainEvent":  "2026-08-20 to 2026-08-23",
    "groupStageStart": "2026-08-13T10:00:00+08:00"   // optional, used by countdown
  },
  "lastUpdated": "2026-06-13T00:00:00+00:00",
  "dataSource": "…",
  "officialUrl": "https://www.dota2.com/esports",
  "demo": false                                       // true shows the demo banner
}
```

The countdown targets `dates.groupStageStart` if present, else parses the first
date in `dates.groupStage`.

## prizePool

```json
"prizePool": {
  "total": 1600000,                  // null/absent shows base + "grows" note
  "distribution": [
    { "place": "1st", "amount": 544000, "team": "Team Falcons" },
    { "place": "2nd", "amount": 256000, "team": null }
  ]
}
```
`amount: null` renders an empty bar (pending). `team` set on "1st" triggers the
champion banner.

## qualifiers[]

```json
{
  "region": "Western Europe",
  "status": "completed",             // completed | live | upcoming | pending
  "winners": ["Team Falcons", "Tundra Esports"],
  "dates": "2026-06-15 to 2026-06-28",
  "slots": 2,
  "teams": ["Team Falcons", "Tundra Esports", "..."],   // optional, for region detail
  "matches": [ Match, Match ]                            // optional, for region detail
}
```

## teams[]

```json
{
  "name": "Team Falcons",
  "region": "Western Europe",
  "qualification": "Regional Qualifier",
  "logo": "https://liquipedia.net/.../falcons.png",     // optional; else initials badge
  "players": [                                           // optional; team detail view
    { "ign": "skiter", "role": "Carry" },
    { "ign": "Sneyking", "role": "Hard Support / Captain" }
  ],
  "coach": "Heen"                                        // optional; "—" or omit = none
}
```

## logos (optional top-level map)

```json
"logos": { "Team Falcons": "https://…", "Team Spirit": "https://…" }
```
Used for teams referenced only by name (qualifier winners, bracket opponents).
The updater fills this from Liquipedia. A team's own `logo` field takes priority.

## groupStage

```json
"groupStage": {
  "format": "Swiss-system (16 teams)",
  "note": "Top 8 advance to the Main Event playoffs.",
  "standings": [
    { "team": "Team Falcons", "wins": 3, "losses": 0, "status": "advanced" },
    { "team": "nouns",        "wins": 0, "losses": 3, "status": "eliminated" }
  ]
}
```
`status`: `advanced` | `eliminated` (or omit — top 8 auto-advance by order).

## bracket

```json
"bracket": {
  "format": "Double elimination — top 8 from the group stage",
  "rounds": {
    "upper": [ Round, Round, ... ],
    "lower": [ Round, Round, ... ]
  },
  "grandFinal": Match
}
```

### Round

```json
{ "name": "Upper Quarterfinals", "matches": [ Match, Match ] }
```

### Match (used in bracket, qualifiers, grand final)

```json
{
  "id": "ubqf1",                     // STABLE id — required; notifications key on it
  "bestOf": 3,
  "status": "completed",             // completed | live | upcoming
  "scheduled": "2026-08-22T12:00:00+00:00",   // for upcoming: shows time + lock deadline
  "streamUrl": "https://twitch.tv/dota2ti",   // optional; shows Watch button on live/upcoming
  "teamA": { "name": "Team Falcons", "score": 2 },
  "teamB": { "name": "Gaimin Gladiators", "score": 0 }
}
```

Rules:
- `score: null` on both → unplayed; shows dashes.
- Winner is highlighted automatically by comparing scores on `completed` matches.
- `name: "TBD"` renders a neutral placeholder and is **not** clickable.
- `id` must stay stable across updates so notifications/predictions track the
  same match.

## Status values (used across the app)

`completed` (a.k.a. `done`) · `live` (a.k.a. `ongoing`) · `upcoming`
(a.k.a. `scheduled`) · `pending` (qualifiers only).

## Minimal valid file

The shipped `data.json` (pre-event seed) is the minimal real example: meta +
prize distribution with null amounts + six pending qualifiers + empty teams /
standings / bracket. The app renders clean "Not started" states from it.

See `data.demo.json` for a fully-populated example (live match, upcoming match,
finished bracket, rosters, logos) — that's the best reference for every field in
use at once.
