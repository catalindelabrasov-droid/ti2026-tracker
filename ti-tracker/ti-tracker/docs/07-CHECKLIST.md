# 07 — Deployment Checklist

A printable, tick-as-you-go list. Details for each item are in docs 01–06.

## Step 1 — Host (doc 01)
- [ ] Create GitHub repo, upload project (keep `.github/` structure)
- [ ] Settings → Pages → deploy from `main` / root
- [ ] Confirm site loads at `https://<user>.github.io/<repo>/`
- [ ] No console errors loading `data.json`

## Step 2 — Data feed (doc 02)
- [ ] Set `LIQUIPEDIA_CONTACT` (repo variable) or edit `CONTACT` in `update_data.py`
- [ ] Actions → enable workflows → Run "Update TI 2026 data" once
- [ ] Confirm it commits an updated `data.json`
- [ ] (Later) implement Match2 parsers for standings + bracket + region matches + rosters
- [ ] Keep Liquipedia attribution in the footer

## Step 3 — Auth + email (doc 03)
- [ ] Create Supabase (or chosen) project
- [ ] Enable email confirmation
- [ ] Paste `email_confirmation_template.html` into the provider's template, map placeholders
- [ ] Set confirmation redirect to `https://your-site/?confirmed=1`
- [ ] Add the client SDK to `index.html` (URL + anon key)
- [ ] Replace `#signupSubmit` / `#signinSubmit` handlers with real calls
- [ ] (Optional) add a `profiles` table for username→email login
- [ ] Restore session on load in `init()`
- [ ] Test: sign up → receive email → click link → land on `?confirmed=1` → sign in

## Step 4 — League backend (doc 04)
- [ ] Create the 4 tables (leagues, members, predictions, outcome_predictions)
- [ ] Enable Row-Level Security (or equivalent)
- [ ] Endpoint: create league (+ email the code to creator)
- [ ] Endpoint: join by code (uses username)
- [ ] Endpoint: lock prediction (server enforces deadline)
- [ ] Endpoint: get match predictions (reveal-after-lock enforced server-side)
- [ ] Endpoint: leaderboard (computed from locked predictions vs results)
- [ ] Decide final rule set from the 43 toggles; implement scoring for those
- [ ] Replace `lgLoad`/`lgSave`/seeding/handlers in `index.html`
- [ ] Test with two accounts on two devices: join same league, predict, lock,
      see each other only after locking, leaderboard updates after a result

## Go-live
- [ ] Remove/keep-out `test_no_login.html` from the deploy (it bypasses login)
- [ ] Verify mobile layout
- [ ] Verify auto-refresh shows new scores within ~30s during a live match
- [ ] Share the URL + a league join code with your friends 🎉
