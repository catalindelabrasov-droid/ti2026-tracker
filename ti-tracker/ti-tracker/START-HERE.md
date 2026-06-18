# START HERE

This is the complete TI 2026 Tracker project. Everything you need to put it
online is in this folder.

## To get it online fast (the short version)

1. Create a free GitHub account + a new repository.
2. Upload **everything in this folder** to the repo (keep the folder structure,
   including the `.github` folder).
3. In the repo: **Settings → Pages → Deploy from branch → `main` / root → Save**.
4. Wait ~1 minute. Your site is live at
   `https://<your-username>.github.io/<repo-name>/`

That's the live tracker done. Full details and the next steps (auto-updating
data, real accounts/email, the shared prediction league) are in **`docs/`** —
start with `docs/00-DEPLOYMENT-GUIDE.md`.

## What's in this folder

| File / folder | What it is |
|---------------|-----------|
| `index.html` | **The app.** This is what gets hosted. |
| `data.json` | The tournament data the app reads (auto-updated later). |
| `data.demo.json` | Sample filled-in data (for previews; not hosted). |
| `update_data.py` | Script that fetches results from Liquipedia. |
| `.github/workflows/update.yml` | Runs the update script on a schedule. |
| `email_confirmation_template.html` | The sign-up confirmation email. |
| `preview_standalone.html` | Offline preview with demo data baked in. |
| `test_no_login.html` | Preview with login bypassed (for testing only — don't host). |
| `docs/` | All deployment guides (hosting, data, auth/email, league). |
| `README.md` | Feature overview. |

## Just want to look at it first?

Open `preview_standalone.html` in your browser — it works offline and shows
everything with sample data. Or `test_no_login.html` to explore the prediction
league without signing in.

## Important notes

- Host `index.html` + `data.json` (the rest of the data/preview files are
  optional). Don't host `test_no_login.html` — it bypasses the login screen.
- The live tracker works immediately once hosted. The "real" accounts, email,
  and shared league need a backend — that's documented step-by-step in `docs/`.
- Tournament data comes from Liquipedia (CC-BY-SA); keep the footer credit.
