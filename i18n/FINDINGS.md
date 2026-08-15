# Russian version — what the extraction actually found

Branch `ru-i18n`. **Nothing on `main` is touched.** Netlify is configured with
`allowed_branches: ["main"]`, so this branch cannot deploy anywhere, not even as
a preview.

## The headline

String-level extraction **does not work** on `index.html`, and it would have
produced a Russian site full of broken sentences. Measured, not guessed:

| | count |
|---|---|
| Strings extracted across 6 pages | 1,138 |
| …after dropping obvious code | 887 |
| **Sentence fragments — untranslatable in isolation** | **183** |
| Self-contained | 704 |
| …of which short UI labels | 453 |

## Why fragments are fatal here specifically

`index.html` builds nearly all its markup inside template literals, so a
sentence is chopped wherever a `${…}` or an inline `<b>` appears. The extractor
faithfully returns the pieces:

```
"— a code library the site loads."
"— live games, scores and in-game statistics."
", hosted in the"
```

In English you can sometimes get away with gluing fragments back together,
because word order is fixed and nouns do not inflect. **In Russian you cannot.**
Word order differs, and every noun takes a case determined by the rest of the
sentence — which the fragment cannot see. Translating `", hosted in the"` and
`"European Union (Ireland)"` separately yields grammatical nonsense.

A second, smaller problem: template literals leak JavaScript into the
dictionary (`' :s===\"eliminated\"?'`). Fixable with better parsing, but it does
not rescue the fragments.

## The approach that does work — split by surface

**1. Prose pages → author Russian versions, do not extract.**
`guide.html` (176), `legal.html` (109), `delete-account.html` (52),
`app/index.html` (50). These are hand-written prose. Writing them in Russian
produces natural Russian; reassembling them from 387 fragments does not. Legal
text especially — a mistranslated "this is not gambling" is worse than English.

**2. App UI → extract only short, self-contained labels.**
Buttons, tab names, column headers, status words. ~453 candidates, and these
genuinely do translate atomically: `Live & Upcoming`, `Lock prediction`,
`Champion`, `Group Stage`.

**3. Counted strings need plural rules, not templates.**
Russian has three forms: `1 игра / 2 игры / 5 игр`. Anywhere the site counts
something — games, wins, series decided — needs a plural function.

**4. Strings that are not ours.**
~17 stage and region names arrive from Liquipedia inside `data.json`
(`Upper Bracket Quarterfinals`, `Southeast Asia`). They need a mapping table
that survives Liquipedia rewording them — which it does; that exact drift broke
scoring on 14 Aug. Team names must never be translated.

**5. Surfaces outside the pages.**
- Push notifications are built server-side, where the user's language is not
  known. Sending Russian pushes means storing a language on the subscription.
- Supabase Auth allows **one** email template per type, so confirmation, reset
  and the deletion link cannot be per-user language without moving to a custom
  mailer.

## Traffic, for the decision

Netlify Analytics, last 30 days, 6,488 visits across 91 countries:

- **RU 52 (0.8 %)**, CIS total 121 (1.9 %) — RU 52, UA 23, BY 19, AZ 10, KZ 9, MD 5, GE 3
- US 3,438 (53 %), RO 1,216 (19 %)
- South-East Asia ≈ 971 — **8× the entire CIS**

Russia is **not blocked**; it was simply below the dashboard's top-10 cut-off.
Current numbers measure who tolerates an English-only site, not who would use a
Russian one — so 52 is a floor, not a ceiling. But it is a bet on latent demand,
not a response to demonstrated demand.

## Files here

- `extract.js` — the extractor. Keeps working for the label set in step 2.
- `strings.en.json` — 1,138 raw strings, kept as evidence for the numbers above.
- `report.txt` — per-page counts and strings shared across contexts.
