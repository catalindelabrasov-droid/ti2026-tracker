# Russian glossary — decisions, with the reason each one was made

Not a dictionary dump. Every line here is a call that a naive translation would
get wrong, and the reason is what stops it being re-litigated later.

Rendered side by side with the English original in `preview/ru-preview.html`.

## Never translated

| | why |
|---|---|
| Team names (`Team Spirit`, `BoomBoys`, `Xtreme Gaming`) | No scene translates them, in any language. Also: `canonTeam()` matches on the English name, so a translated name silently drops out of the field and breaks scoring. |
| Player nicknames | Same. |
| `Bo3` / `Bo5` | Russian casters say "бо3". Translating it to "до 2 побед" reads as a machine. |
| Hero and item names | Dota 2's own Russian client localises these, and it disagrees with common usage. Out of scope; we do not display them as prose. |

## Tournament vocabulary

| English | Русский | note |
|---|---|---|
| Group Stage | Групповой этап | |
| Playoffs | Плей-офф | hyphenated; "плейофф" is a common misspelling |
| Upper / Lower Bracket | Верхняя / нижняя сетка | not "скобка" — that is a punctuation bracket |
| Grand Final | Гранд-финал | |
| Qualified | Прошли | plural verb, see below |
| Eliminated | Вылетели | |
| Clean sweep | Всухую | adverb: "выиграли всухую" |
| Upset | Апсет | borrowed and standard in the RU scene |
| Prize pool | Призовой фонд | |
| the Aegis | Эгида | **not** "Аегис". Dota 2's Russian client calls the trophy Эгида, and every viewer knows it. |
| Draft | Драфт | |
| Net worth | Нетворс | what casters say; the client's "Ценность" is not used in speech |
| Last hits / denies | Добивания / денаи | |

## Collisions the English does not have

**`Streak` → `Подряд`, not `Серия`.**
Russian uses *серия* for a Bo3 **series**. Using it for a win streak puts two
different meanings in the same leaderboard. `Подряд` ("in a row") is short,
unambiguous, and fits the column.

**`Live` → `Идёт`.**
`LIVE` is also acceptable — RU esports sites use it untranslated. `Идёт` was
chosen because everything around it is Russian and the mixed-script badge looked
like an oversight rather than a choice. Reversible.

## Grammar that makes fragment translation impossible

**Teams take plural verbs.** *BoomBoys обыграли OG* — plural, because a team is
understood as people. English `beat` never changes; the Russian verb changes for
gender and number, and a fragment cannot see which it needs.

**Three plural forms, chosen by the last two digits:**

```
1 игра    21 игра    101 игра        -> ends in 1, but not 11
2 игры     3 игры      4 игры        -> ends in 2-4, but not 12-14
5 игр     11 игр      14 игр    0 игр
```

Every counted string needs a function, not a template. `11` and `21` both end in
`1` and behave differently — that is the case a hand-written `n === 1 ? … : …`
gets wrong.

**Nouns inflect for case.** The case of a noun is decided by the rest of the
sentence, which a fragment cannot see. This is the concrete reason the 183
extracted fragments in `FINDINGS.md` are not translatable in isolation, and why
prose pages get authored rather than assembled.

## Strings that are not ours

Stage and region names arrive from Liquipedia inside `data.json`
(`Upper Bracket Quarterfinals`, `Southeast Asia`, round numbers). They need a
mapping table that tolerates Liquipedia rewording them — it does; that exact
drift broke scoring on 14 Aug 2026.
