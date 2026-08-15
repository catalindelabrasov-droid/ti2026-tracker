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

**6. The site cannot currently render Russian at all.**
Found while building the preview, not predicted. The three self-hosted faces —
Oswald, Inter, JetBrains Mono — ship only the `latin` and `latin-ext` subsets.
There is no Cyrillic in any of them, so Russian text would silently fall back to
the system font and look foreign on our own domain.

**Three** more woff2 files, +38 KB total. Not six: the files in `/fonts/` are
variable fonts, so one file per family per subset covers every weight — which is
why `index.html` declares eight `@font-face` rules per family that all point at
the same two files. (The preview embeds twelve static faces instead, because
that is what the `css2` API returns for an explicit weight list. Its font bill
is not the site's font bill.)

## How it ships — alias + `/ru/`

Russian lives at `dota2tileague.com/ru/`, as its own files. The English site is
not edited, which is the whole point: nothing that is serving TI right now gets
touched.

A Netlify **domain alias** on the same site, rewritten to that path, gives the
second address without splitting search reputation across two domains. One trap:
Netlify answers `301` to the primary domain for every non-primary alias by
default. Left on, the alias just bounces readers to the English site — it has to
be turned off for the rewrite to survive.

On `Дота2Тилиг.ru` specifically: it becomes `xn--2-7sbkbwauu0bc.ru` in punycode
everywhere it is not rendered as text, and *Тилиг* is not a Russian word — league
is **лига**. Cyrillic domains also conventionally live under `.рф`, not `.ru`.

## What `/ru/` shares with the English site

The pages are separate files, so no English copy changes. Four things are still
shared, and they are where any damage would come from:

**`netlify.toml` — the only thing that can actually break English.** The alias
rewrite is a `[[redirects]]` block in the same file that configures headers for
the whole site. A malformed rule ships to every visitor, not just Russian ones.
Add it via a deploy preview and check the English routes before promoting.

**`sw.js` — bumping `VERSION` invalidates the shell for everybody.** If `/ru/`
or the Cyrillic fonts go into `PRECACHE`, `v7` becomes `v8` and every installed
user re-downloads the shell once, English included. Cheaper not to precache
Russian from the English worker at all: the Cyrillic files are never fetched by
an English page anyway, because `unicode-range` tells the browser they contain
nothing it needs.

**One deploy for both.** The build command is only `rm -f test_no_login.html`,
so a broken Russian page cannot fail the build — but it does ship in the same
deploy as English.

**Supabase is one project.** Russian users are just users: same leagues, same
leaderboard, same rate limits. And Auth allows one email template per type, so
the confirmation and reset mails stay English for everyone unless we move to a
custom mailer.

Optional, and the only change worth making to English pages: a
`<link rel="alternate" hreflang="ru">` pair in `<head>` so search engines treat
the two as translations rather than near-duplicates. Two lines, no behaviour.

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
- `labels.js` / `labels.en.json` — the 341 atomic labels that do translate.
- `glossary.ru.md` — the terminology calls, each with its reason.
- `preview/ru-preview.src.html` — the preview page itself.
- `preview/build.js` — embeds the fonts; `node i18n/preview/build.js`.
- `preview/ru-preview.html` — generated, ~390 KB, opens offline. Not committed.

Nothing here is wired into any page. `index.html` is byte-identical to `main`.
