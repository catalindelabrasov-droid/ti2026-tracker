# 01 — Hosting the Static Site

Goal: get the tracker live at a public URL. After this step the live tracker
(countdown, prize pool, qualifiers, teams, bracket) works for anyone.

## Option A — GitHub Pages (recommended, free)

1. **Create a GitHub repo** and upload the project (keep the folder structure,
   including `.github/workflows/update.yml`). At minimum you need `index.html`
   and `data.json` at the repo root.
2. **Enable Pages**: repo Settings → **Pages** → Source: *Deploy from a branch*
   → Branch: `main`, Folder: `/ (root)` → Save.
3. Wait ~1 minute. Your site is live at
   `https://<your-username>.github.io/<repo-name>/`.
4. Open it. The tracker loads `data.json` and renders. (It will show the
   pre-event "Not started" states until the data feed is populated — that's
   step 02.)

That's it for basic hosting.

### Custom domain (optional)
Settings → Pages → Custom domain. Add a `CNAME` DNS record at your registrar
pointing to `<your-username>.github.io`. GitHub provisions HTTPS automatically.

## Option B — Netlify or Vercel (also free)

- Drag-and-drop the folder onto Netlify, or connect the GitHub repo to
  Netlify/Vercel. Both auto-deploy on every push and give HTTPS + a URL.
- No build command needed — it's a static site. Publish directory = repo root.

## Option C — Any static host / your own server

Because it's plain HTML/CSS/JS, you can serve it from anything: an S3 bucket +
CloudFront, Cloudflare Pages, nginx/Apache on a VPS, etc. Just serve the files
over HTTPS. The only requirement: `data.json` must be reachable at the same
origin as `index.html` (the app fetches `./data.json`).

## What to deploy vs. keep local

Deploy: `index.html`, `data.json`, and (if used) any logo assets.
Keep local / don't need to deploy: `preview_standalone.html`,
`test_no_login.html`, `data.demo.json`, `docs/`. They don't hurt anything if
uploaded, but they aren't part of the live site.

## Verify

- The page loads over `https://`.
- No console errors about `data.json` (if you see one, confirm the file is at
  the repo root and that you're not opening via `file://`).
- On mobile, the layout is responsive (it's designed mobile-first).

## Caching note

GitHub Pages caches aggressively. The app already cache-busts `data.json` with a
`?_=timestamp` query param on every fetch, so live updates show without users
hard-refreshing. If you change `index.html` itself, a normal refresh picks it up
within a minute.

Next: [02-DATA-AUTOUPDATE.md](02-DATA-AUTOUPDATE.md).
