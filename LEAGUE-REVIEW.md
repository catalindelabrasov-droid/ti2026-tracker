# TI 2026 League â€” Final Rules & Scoring Recommendation

**Verdict in one line:** ship a league that scores 100% of what it shows. Today 6 rules are ON by default but only 2 pay out â€” that is a guaranteed end-of-tournament trust failure. Cut 28 of the 46 toggles, keep 11, add 4 new scoreable props, and make the RPC honor every toggle that remains visible.

---

## 1. KEEP

### Default ON (all must actually score â€” see Â§4)

| Rule | Pts | Why |
|---|---|---|
| `winner` | 10 | The daily heartbeat â€” ~8-10 Swiss series/day settle; already live. |
| `exactScore` | +15 | TI2025 ran ~50/50 2-0 vs 2-1, so it's a real second skill signal at zero data cost; already live. |
| `champion` | 50 | Highest emotion-per-byte; resolves from one row (GF winner). TI2025 (Liquid & Spirit both missing playoffs) proves favorites bust â€” that's the fun. |
| `grandFinalists` | 25/team | Derivable from ub-final + lb-final winners; ONE Esports-proven weighting. |
| `topFour` | 20/team | Derivable from semifinal participants via bracket match ids; kind already exists. |
| `tbExactHits` (TB) | â€” | Free tie-breaker from data the RPC already touches. |
| `tbChampion` (TB) | â€” | Free once champion scoring lands. |

### Keep in UI, default OFF (A/B-class, cheap opt-ins)

| Rule | Pts | Why |
|---|---|---|
| `gameCountOU` | 6 | Total games = score_a+score_b, already stored. (Absorbs `sweepOverUnder` â€” identical in Bo3; keep only this one.) |
| `champFromLB` | 20 | Pure fun, fully derivable from match ids ('lb-final' winner in GF). Xtreme Gaming's 2025 LB run is the ad for it. |
| `topEight` | 10/team | = bracket R1 participants, free once Liquipedia bracket parsing lands. |
| `negativePoints` | âˆ’5 | Needs nothing new; some groups love the sweat. |
| `firstGame` | 5 | B-class â€” turns on the day the per-game rows table (Â§4.4) ships. |
| `reverseSweep` | 12 | B-class, same dependency; rare but legendary when it hits. |
| `tbFinalH2H` (TB) | â€” | Uses stored GF predictions, zero new data. |

**Score modes:** keep `flat` (default) and `Round-weighted` (stage multiplier from match-id prefixes q-/swiss/ub-/lb-/gf â€” one small map in the RPC). Delete `Odds-based` (no odds data, never will be for this TI). Keep `lockLeadMs` as the only config field.

---

## 2. CUT â€” remove from the UI entirely

Delete these 27 toggles. Every one is C/D-class (data not collected) or duplicative; each is currently a disabled-looking promise that will never pay out.

- **Duplicative A-class (cut even though scoreable):** `correctMargin` (given a correct winner in Bo3, margin = exact score; it only pays when your winner is *wrong*, which is perverse), `cleanSweep` (a 2-0 exactScore hit already is this), `exactFinal` (same data as grandFinalists, near-same payout), `sweepOverUnder` (= gameCountOU in Bo3), `closestScore` (cross-member per-match comparison for 3 pts â€” complexity nobody will notice).
- **Needs seeds/odds â€” not collected:** `upsetBonus` (replaced by consensus version in Â§3), `breakoutTeam`, `cinderella`, `diminishing`.
- **Needs Swiss standings/tiebreakers â€” not collected:** `lastPlace`, `groupWinner`, `bottomFour` (the *good* Swiss props return in Â§3 in scoreable form).
- **Needs region/history metadata:** `regionPerf`, `regionHero`, `finalsRematch`.
- **Needs day/week grouping or scoring timeline â€” not stored:** `perfectDay`, `weeklyMVP`, `comebackBonus`, `streakBonus`, `tbThreshold`, `earlyLockBonus`.
- **Mechanics, not rules (no scoring math, unbuilt flows):** `confidence`, `lockOfDay`, `jokerCard`, `wildcardWeek`, `mulligan` (toggle exists, feature doesn't â€” actively misleading), `stageGates`, `survivorPool`, `headToHead`, `percentile`, `bonusPool`, `perfectBracket` (no bracket-picking UI exists; 200-pt jackpot on vapor).

Result: rules screen drops from ~46 rows to 14 + 2 config fields. No "coming soon" graveyard â€” if it's not scoreable this TI, it's gone.

---

## 3. ADD â€” new predictions we can actually score

1. **Swiss props (CS2-Major style):** three picks locked before Aug 13 â€” the 3-0 team (15 pts), the 0-3 team (15 pts), and the 8 playoff advancers (5/team). *Data:* advancers = bracket R1 participants (already coming); 3-0/0-3 records from the Liquipedia Match2 group parser in progress. *Why:* one lock, four days of watercooler value across the whole Swiss stage.
2. **Lone-wolf bonus (consensus upset bonus):** +5 (or +50%) when your correct winner was picked by â‰¤25% of your league on that match. *Data:* none â€” one window/count over `predictions` inside the RPC. *Why:* directly rewards fading Team Spirit; highest fun-per-line-of-code on the list.
3. **Event over/unders:** two picks locked before Aug 13 â€” total playoff 2-0 sweeps O/U (10 pts) and longest game of the event O/U at 60 min (10 pts). *Data:* first is free (stored series scores); second needs the per-game rows table (Â§4.4, which firstGame/reverseSweep need anyway). Settles at event end alongside champion.
4. **Bracket sheet (stretch â€” only if time after 1-3):** pick every playoff series winner before Aug 20, escalating points by round (UB R1 5 â†’ GF 20) via the Round-weighted map. *Data:* all A-class from bracket match_results; cost is the new picker UI + propagation handling ("team already eliminated" picks score 0, no re-picks). Skip without guilt if the deadline bites.

---

## 4. CORE SYSTEM changes (implementation order)

1. **Make the RPC honor the rules JSON.** `league_leaderboard()` must read `leagues.rules` and score only enabled rules at their configured pts (winner, exactScore, negativePoints, gameCountOU, lone-wolf bonus, round-weighted multiplier). Never again show a toggle the RPC ignores.
2. **Outcome resolution at event end.** Extend the RPC (or a `resolve_outcomes()` companion) to score `outcome_predictions` from bracket `match_results` by id convention: GF winner â†’ champion; GF participants â†’ grandFinalists; UB-final + LB-final participants â†’ topFour; bracket-R1 participants â†’ topEight; LB-final winner appearing in GF â†’ champFromLB. No new tables â€” pure derivation. This is the highest-priority gap: it's already promised in the UI.
3. **`matches` table in the DB** (match_id PK, team_a, team_b, best_of, scheduled_at, stage). Currently schedule is client-side only. Unlocks: server-side lock enforcement (reject prediction upserts after `scheduled_at âˆ’ lockLeadMs` via RLS/trigger), real deadline display with dates, and outcome-pick deadlines (champion/top4/Swiss props hard-lock at Aug 13 stage start â€” today they're open forever, including after the semifinals).
4. **`match_games` table** (match_id, game_no, winner, duration, start_time) filled by the existing hourly OpenDota job â€” the rows exist upstream, just persist them. Unlocks firstGame, reverseSweep, longest-game O/U.
5. **New `outcome_predictions` kinds** â€” `swiss30`, `swiss03`, `advancers`, `totalSweeps`, `longestGame` â€” resolved from the group parser + match_games.
6. **`get_match_predictions` gating change:** reveal all picks for a match once its lock deadline passes (not only to users who locked), and reveal everyone's champion/top-4 picks once outcome lock passes. Banter is the product; the current rule hides it.

---

## 5. UI / simplicity â€” top 5 buildable items

1. **One entry point, no dead-end sign-in.** `#leagueBtn` label becomes "Prediction League" when not in a league and the active league's name when in one; fold My Leagues into it. After sign-in initiated from the league lock screen, reopen the league overlay instead of dropping the user on the tracker.
2. **Fix inviting.** Show the join code to all members, add a `navigator.share` button with a prefilled invite message, and delete the false "code has been emailed to you" toast/copy. This is the single biggest growth fix for a friends group on mobile.
3. **Bulletproof the pick card.** Replace the two number inputs with tap chips derived from best_of ("2-0" / "2-1", auto-oriented to the picked winner) â€” kills contradictory 3-0-in-a-Bo3 picks. Lock gets a 5-second undo toast. Fix the wipe: fetch others' picks *before* rendering (one batched RPC) or patch only `.pred-others` nodes instead of the full `#lgPanel` innerHTML replace at line ~1997.
4. **Rules page as presets.** After the Â§2 cut, show 3 presets (Casual / Standard / Sweaty) on top of the 14 remaining toggles; non-admins see a read-only summary ("Winner 10 Â· Exact 15 Â· Champion 50 â€¦"), not 43 disabled switches. Single Save button; fix the admin check to uid-based `lg.isAdmin`.
5. **My Picks history + verifiable leaderboard.** A per-user history block (data already in `predictions` + `match_results`): each finished match with your pick, the result, and "+10 / +25 / â€”" chips. Group prediction cards by day with full dates ("Wed Aug 13, 3:30 PM"), collapse past-deadline matches, and `history.pushState` on open so mobile gesture-back closes the league instead of exiting the site.

**Build order for the owner:** Â§4.1-4.2 (score what's promised) â†’ Â§5.2-5.3 (invite + pick card) â†’ Â§4.3 (matches table + locks) â†’ Â§3.1-3.2 before Aug 13 â†’ Â§4.4 + Â§3.3 â†’ Â§5.4-5.5 â†’ Â§3.4 only if time remains.