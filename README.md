# Falls Creek Snow & Lift Report

Two pieces:

- **`index.html`** — the website. Static, no build step. Shows current conditions,
  a 14-day forecast (live from Open-Meteo), lift status, and the email signup form.
- **`server.js`** (+ `package.json`, `.env.example`) — the backend. Stores emails,
  sends a report immediately on signup, and sends every subscriber a report daily
  at 8am (Australia/Melbourne).

Why two pieces: a static site can't send emails or run on a schedule by itself —
there's no server behind it once it's just files in a browser. The backend is
what actually does that.

---

## The cheapest way to run this: **$0/month**

This stack costs nothing at real-world small scale (a personal site with up to a
few hundred subscribers):

| Piece | Service | Free tier |
|---|---|---|
| Website hosting | **Netlify** or **GitHub Pages** | Free, forever |
| Backend hosting | **Render** (free web service) | Free, but sleeps after 15 min idle |
| Wake-up + 8am trigger | **cron-job.org** | Free |
| Email sending | **Resend** | Free — 3,000 emails/month, 100/day |

The one gotcha: Render's free tier puts your server to sleep when idle, so its
own internal clock can't reliably fire at exactly 8am. We solve that with an
external, free scheduler that pings the server at 8am — which also wakes it up
if it was asleep. The code already has an endpoint built for this
(`/api/cron/send-daily`), so you don't need to change anything.

> If your subscriber list grows large or you want guaranteed on-time delivery,
> the cheap upgrade path is a $5–7/month always-on host (Railway, Fly.io, a
> small VPS) so the server never sleeps and Resend's free tier is your only
> real ceiling.

### Known limitation on the free path

Render's free tier disk isn't guaranteed to persist across redeploys. For a
small hobby list this is usually fine (subscribers.json will typically survive
day-to-day), but if you redeploy the backend, you could lose the list. If that
matters to you, the fix is swapping the JSON file for a free hosted database
(e.g. Supabase or Neon both have free Postgres tiers) — the two functions
`loadSubscribers()` / `saveSubscribers()` in `server.js` are the only place
you'd need to change.

---

## Step-by-step

### 1. Get a Resend API key (sends the emails)
1. Sign up free at [resend.com](https://resend.com).
2. Go to **API Keys** → create one → copy it.
3. For quick testing you can send from `onboarding@resend.dev` (no setup).
   To send from your own address later (e.g. `reports@yourdomain.com`),
   verify a domain under **Domains** in Resend — takes a few DNS records.

### 2. Put the backend on GitHub
1. Create a new GitHub repo.
2. Add `server.js`, `package.json`, `.env.example` (don't commit a real `.env`).
3. Push.

### 3. Deploy the backend to Render
1. Sign up free at [render.com](https://render.com).
2. **New → Web Service** → connect your GitHub repo.
3. Settings:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
4. Under **Environment**, add these variables (from `.env.example`):
   - `RESEND_API_KEY` — from step 1
   - `FROM_EMAIL` — `onboarding@resend.dev` to start
   - `CRON_SECRET` — any random string, e.g. run `openssl rand -hex 16` locally
   - `TIMEZONE` — `Australia/Melbourne`
   - `UNSUBSCRIBE_BASE_URL` — fill this in *after* deploy once you have your
     Render URL, e.g. `https://falls-creek-report.onrender.com`
5. Deploy. Once live, note your URL, e.g. `https://falls-creek-report.onrender.com`.

### 4. Set up the free scheduled triggers
Sign up free at [cron-job.org](https://cron-job.org) and create **two** cron jobs:

**Daily report (8am):**
- **URL:** `https://your-app.onrender.com/api/cron/send-daily`
- **Method:** `POST`
- **Header:** `x-cron-secret: <the CRON_SECRET you set in step 3>`
- **Schedule:** daily at `08:00`, timezone `Australia/Melbourne`

**Lift status refresh (near real-time):**
- **URL:** `https://your-app.onrender.com/api/cron/refresh-lifts`
- **Method:** `POST`
- **Header:** `x-cron-secret: <same CRON_SECRET>`
- **Schedule:** every 15 minutes

Both are free — cron-job.org's free plan allows unlimited jobs down to
1-minute intervals, so 15 minutes for lift status is comfortably inside
that. This also happens to double as a keep-alive ping for Render's free
tier (which sleeps after ~15 min idle), so it helps the daily-send cron
fire more reliably too.

### 5. Put the website live
1. In `index.html`, set `API_BASE_URL` (near the top of the `<script>` block)
   to your Render URL from step 3, e.g.:
   ```js
   const API_BASE_URL = "https://falls-creek-report.onrender.com";
   ```
2. Deploy `index.html` anywhere static and free:
   - **Netlify:** drag-and-drop the file at [app.netlify.com/drop](https://app.netlify.com/drop), or
   - **GitHub Pages:** push it to a repo, enable Pages in repo settings.
3. Visit your live site and test the signup form with your own email.

### 6. How live lift status works
Falls Creek publishes an official JSON data feed that their own website's
snow report page reads from — found via browser DevTools (Network tab):

```
https://www.fallscreek.com.au/wp-content/uploads/FCSnowReport_2021.json
```

It includes each lift's name, operating hours, and status split into
morning/afternoon sessions, plus an official `LastUpdate` timestamp. This
is what the backend now reads — no HTML scraping or guessing involved.

- `POST /api/cron/refresh-lifts` fetches this feed and caches the result
  (`lift-status-cache.json`). Point cron-job.org at this every 15 minutes
  (step 4) to keep it fresh.
- `GET /api/lifts` — what the website and emails actually read from —
  serves that cached value instantly. If the cache is missing or older
  than an hour (e.g. the cron job isn't set up yet), it fetches fresh on
  the spot instead of showing nothing.
- The headline "X of Y open" number picks whichever session (morning/
  afternoon) matches the current time in Melbourne; the per-lift list
  below it always shows both sessions, so nothing is hidden by that
  guess.

**Fragility note:** this URL isn't a published/documented API — it's the
internal data file Falls Creek's own site happens to use. If they ever
restructure their site (e.g. rename the file, change its shape, or move
to a different report system), this will need to be found again the same
way (DevTools → Network tab → look for the JSON request) and the
`FALLS_CREEK_JSON_URL` constant near the top of `server.js` updated.
Worth a quick check if lift status ever looks stuck or wrong.

---

## Running locally first (recommended before deploying)

```bash
npm install
cp .env.example .env   # fill in RESEND_API_KEY at minimum
npm start
```

Then open `index.html` in a browser with `API_BASE_URL` set to
`http://localhost:3000` and try subscribing with your own email.

---

## What each file does

- `index.html` — the whole front-end, single file, no build step.
- `server.js` — Express server: `/api/subscribe`, `/api/unsubscribe`,
  `/api/lifts`, `/api/cron/send-daily`, `/api/cron/refresh-lifts`, plus
  internal cron jobs for if you ever move to an always-on host.
- `subscribers.json` — created automatically, one email per line of JSON array.
- `lift-status-cache.json` — created automatically; holds the last scraped
  lift status (open count, total, timestamp). Don't edit by hand — it's
  overwritten by every scrape.
- `.env.example` — copy to `.env` locally; set the same values as dashboard
  environment variables on your host.
