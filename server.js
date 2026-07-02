// Falls Creek Snow & Lift Report — backend
// ---------------------------------------------------------------
// What this does:
//   1. POST /api/subscribe   -> saves an email, sends it a report immediately
//   2. Sends the same report to every subscriber every day at 8am
//      (Australia/Melbourne time), two ways at once for reliability:
//        a) an internal cron job (node-cron) — works if the server
//           stays running 24/7
//        b) POST /api/cron/send-daily — a secret-protected endpoint you
//           point a free external scheduler (cron-job.org) at. This is
//           the one that matters if you deploy somewhere that "sleeps"
//           when idle (e.g. a free web service tier).
//   3. Keeps a near-real-time lift status by periodically scraping
//      Falls Creek's official snow report page:
//        a) POST /api/cron/refresh-lifts — secret-protected endpoint,
//           point a free external scheduler at this too (e.g. every
//           15 minutes) to keep the cached value fresh.
//        b) GET /api/lifts — serves the cached value instantly. If the
//           cache is missing or very stale, it scrapes fresh before
//           responding, so it's never completely empty.
//
//      Note: Falls Creek's site only publishes an aggregate count
//      ("X out of 15 Lifts Open"), not a named per-lift breakdown, so
//      that's what's scraped. If Falls Creek changes their page layout,
//      the scraper may need a small update — see scrapeLiftStatus().
//
// Storage: simple JSON files (subscribers.json, lift-status-cache.json).
// Fine for a personal project / small list. If you outgrow it, swap the
// load*/save* helpers for a hosted DB (e.g. free Supabase/Neon Postgres).
// ---------------------------------------------------------------

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const fs = require("fs/promises");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || "onboarding@resend.dev";
const CRON_SECRET = process.env.CRON_SECRET || "changeme";
const TIMEZONE = process.env.TIMEZONE || "Australia/Melbourne";
const UNSUBSCRIBE_BASE_URL = process.env.UNSUBSCRIBE_BASE_URL || `http://localhost:${PORT}`;

const SUBSCRIBERS_FILE = path.join(__dirname, "subscribers.json");
const LIFT_CACHE_FILE = path.join(__dirname, "lift-status-cache.json");

// How stale the cache can get before GET /api/lifts scrapes fresh
// instead of serving the cached value. The cron job (every ~15 min,
// see README) normally keeps it much fresher than this — this is
// just a safety net if the cron job isn't set up yet or missed a run.
const LIFT_CACHE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

// Falls Creek Alpine Resort, VIC, Australia
const LAT = -36.8768;
const LON = 147.2802;
const SNOW_REPORT_URL = "https://www.fallscreek.com.au/snowreport/";

// ---------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------
async function loadSubscribers() {
  try {
    const raw = await fs.readFile(SUBSCRIBERS_FILE, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function saveSubscribers(list) {
  await fs.writeFile(SUBSCRIBERS_FILE, JSON.stringify(list, null, 2));
}

async function loadLiftCache() {
  try {
    const raw = await fs.readFile(LIFT_CACHE_FILE, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

async function saveLiftCache(data) {
  await fs.writeFile(LIFT_CACHE_FILE, JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------
// Lift status — scraped from Falls Creek's official snow report page
// ---------------------------------------------------------------
async function scrapeLiftStatus() {
  const res = await fetch(SNOW_REPORT_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; FallsCreekReportBot/1.0)" },
  });
  if (!res.ok) throw new Error(`Snow report page request failed: ${res.status}`);
  const html = await res.text();

  // Strip tags to plain text so this survives minor markup changes,
  // then look for the pattern "<number> out of <number> Lifts Open".
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const match = text.match(/(\d+)\s+out of\s+(\d+)\s+Lifts?\s+Open/i);

  if (!match) {
    throw new Error("Couldn't find lift status on the page — Falls Creek may have changed their page layout.");
  }

  return {
    open: parseInt(match[1], 10),
    total: parseInt(match[2], 10),
    lastChecked: new Date().toISOString(),
    source: SNOW_REPORT_URL,
  };
}

async function refreshLiftCache() {
  const status = await scrapeLiftStatus();
  await saveLiftCache(status);
  console.log(`Lift status refreshed: ${status.open}/${status.total} open`);
  return status;
}

async function getLiftStatus() {
  const cached = await loadLiftCache();
  const isStale = !cached || Date.now() - new Date(cached.lastChecked).getTime() > LIFT_CACHE_MAX_AGE_MS;

  if (!cached) {
    // Never scraped before — do it now so the endpoint isn't empty.
    return refreshLiftCache();
  }

  if (isStale) {
    // Serve the stale value immediately, but kick off a background
    // refresh so the *next* request gets a fresh one. Keeps responses
    // fast even if a scrape is slow or the cron job missed a run.
    refreshLiftCache().catch((err) => console.error("Background lift refresh failed:", err.message));
  }

  return cached;
}

// ---------------------------------------------------------------
// Weather (Open-Meteo — free, no API key, up to 16-day forecast)
// ---------------------------------------------------------------
async function getWeather() {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
    `&daily=weathercode,temperature_2m_max,temperature_2m_min,snowfall_sum` +
    `&current=temperature_2m,weathercode,windspeed_10m` +
    `&timezone=${encodeURIComponent(TIMEZONE)}&forecast_days=16`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo request failed: ${res.status}`);
  return res.json();
}

function weatherEmoji(code) {
  if ([0].includes(code)) return "☀️";
  if ([1, 2].includes(code)) return "🌤️";
  if ([3].includes(code)) return "☁️";
  if ([45, 48].includes(code)) return "🌫️";
  if ([51, 53, 55, 56, 57].includes(code)) return "🌦️";
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "🌧️";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "🌨️";
  if ([95, 96, 99].includes(code)) return "⛈️";
  return "❄️";
}

// ---------------------------------------------------------------
// Report HTML
// ---------------------------------------------------------------
function buildReportHtml({ weather, lifts, isWelcome, email }) {
  const current = weather.current;
  const todaySnow = weather.daily.snowfall_sum[0];

  const forecastRows = weather.daily.time
    .slice(0, 14)
    .map((dateStr, i) => {
      const d = new Date(dateStr + "T00:00:00");
      const label = d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
      const max = Math.round(weather.daily.temperature_2m_max[i]);
      const min = Math.round(weather.daily.temperature_2m_min[i]);
      const snow = weather.daily.snowfall_sum[i];
      const icon = weatherEmoji(weather.daily.weathercode[i]);
      return `<tr>
        <td style="padding:6px 10px;font-size:13px;color:#334;">${label}</td>
        <td style="padding:6px 10px;font-size:15px;">${icon}</td>
        <td style="padding:6px 10px;font-size:13px;">${max}° / ${min}°</td>
        <td style="padding:6px 10px;font-size:13px;color:${snow > 0 ? "#2b8a5e" : "#889"};">${snow > 0 ? snow.toFixed(0) + " cm" : "—"}</td>
      </tr>`;
    })
    .join("");

  const liftCheckedTime = new Date(lifts.lastChecked).toLocaleTimeString("en-AU", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: TIMEZONE,
  });

  const unsubscribeUrl = `${UNSUBSCRIBE_BASE_URL}/api/unsubscribe?email=${encodeURIComponent(email)}`;

  return `
  <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#0F1B2D;color:#F5F8FA;padding:28px;border-radius:12px;">
    <p style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:#7DD8E8;margin:0 0 6px;">Falls Creek · ${isWelcome ? "Welcome" : "Daily"} report</p>
    <h1 style="font-size:24px;margin:0 0 18px;">${isWelcome ? "You're on the list! ❄️" : "Today on the mountain"}</h1>

    <div style="background:#16263D;border-radius:10px;padding:16px 18px;margin-bottom:18px;">
      <p style="margin:0;font-size:13px;color:#9FB3C8;">RIGHT NOW</p>
      <p style="margin:6px 0 0;font-size:20px;">${weatherEmoji(current.weathercode)} ${Math.round(current.temperature_2m)}°C · wind ${Math.round(current.windspeed_10m)} km/h</p>
      <p style="margin:6px 0 0;font-size:13px;color:#9FB3C8;">New snow today: ${todaySnow.toFixed(1)} cm</p>
    </div>

    <div style="background:#16263D;border-radius:10px;padding:16px 18px;margin-bottom:18px;">
      <p style="margin:0;font-size:13px;color:#9FB3C8;">LIFT STATUS</p>
      <p style="margin:6px 0 0;font-size:20px;">${lifts.open} of ${lifts.total} lifts open</p>
      <p style="margin:6px 0 0;font-size:12px;color:#6b7d92;">as of ${liftCheckedTime} · source: fallscreek.com.au</p>
    </div>

    <p style="font-size:13px;color:#9FB3C8;margin:0 0 6px;">14-DAY OUTLOOK</p>
    <table style="width:100%;border-collapse:collapse;background:#16263D;border-radius:10px;overflow:hidden;margin-bottom:18px;">
      ${forecastRows}
    </table>

    <p style="font-size:11px;color:#6b7d92;">
      Not an official Falls Creek Alpine Resort service. Verify before you travel at
      <a href="https://www.fallscreek.com.au" style="color:#7DD8E8;">fallscreek.com.au</a>.
      <br><a href="${unsubscribeUrl}" style="color:#6b7d92;">Unsubscribe</a>
    </p>
  </div>`;
}

// ---------------------------------------------------------------
// Sending via Resend (https://resend.com — free tier: 3,000 emails/mo,
// 100/day, no domain verification needed if you send from
// onboarding@resend.dev while testing)
// ---------------------------------------------------------------
async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) {
    console.warn("RESEND_API_KEY not set — skipping actual send. Would have sent:", { to, subject });
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend error ${res.status}: ${body}`);
  }
}

async function sendReportTo(email, isWelcome) {
  const [weather, lifts] = await Promise.all([getWeather(), getLiftStatus()]);
  const html = buildReportHtml({ weather, lifts, isWelcome, email });
  await sendEmail({
    to: email,
    subject: isWelcome ? "Welcome — your first Falls Creek report" : "Falls Creek snow & lift report — today",
    html,
  });
}

async function sendDailyReportToAll() {
  const subscribers = await loadSubscribers();
  if (subscribers.length === 0) {
    console.log("No subscribers, skipping daily send.");
    return;
  }
  const [weather, lifts] = await Promise.all([getWeather(), getLiftStatus()]);
  console.log(`Sending daily report to ${subscribers.length} subscriber(s)...`);
  for (const email of subscribers) {
    try {
      const html = buildReportHtml({ weather, lifts, isWelcome: false, email });
      await sendEmail({ to: email, subject: "Falls Creek snow & lift report — today", html });
    } catch (err) {
      console.error(`Failed to send to ${email}:`, err.message);
    }
  }
}

// ---------------------------------------------------------------
// Routes
// ---------------------------------------------------------------
app.get("/api/health", (req, res) => res.json({ ok: true }));

app.get("/api/lifts", async (req, res) => {
  try {
    res.json(await getLiftStatus());
  } catch (err) {
    console.error("Lift status fetch failed:", err.message);
    res.status(502).json({ error: "Couldn't retrieve lift status right now." });
  }
});

app.post("/api/subscribe", async (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }

  const subscribers = await loadSubscribers();
  if (!subscribers.includes(email)) {
    subscribers.push(email);
    await saveSubscribers(subscribers);
  }

  try {
    await sendReportTo(email, true);
  } catch (err) {
    console.error("Welcome email failed:", err.message);
    // Still return success — they're subscribed, tomorrow's 8am send will retry.
  }

  res.json({ ok: true });
});

app.get("/api/unsubscribe", async (req, res) => {
  const email = (req.query.email || "").trim().toLowerCase();
  const subscribers = await loadSubscribers();
  const next = subscribers.filter((e) => e !== email);
  await saveSubscribers(next);
  res.send("<p style='font-family:sans-serif'>You've been unsubscribed. Sorry to see you go — stay safe out there.</p>");
});

// Secret-protected endpoint for an external scheduler (cron-job.org etc.)
// to trigger the daily send. Use this if your host puts the server to
// sleep when idle — an internal cron job won't fire while asleep, but an
// external HTTP ping will wake it up.
app.post("/api/cron/send-daily", async (req, res) => {
  if (req.headers["x-cron-secret"] !== CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    await sendDailyReportToAll();
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Secret-protected endpoint for an external scheduler to keep the lift
// status cache fresh (recommended: every 15 minutes — see README).
app.post("/api/cron/refresh-lifts", async (req, res) => {
  if (req.headers["x-cron-secret"] !== CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const status = await refreshLiftCache();
    res.json({ ok: true, ...status });
  } catch (err) {
    console.error("Lift refresh failed:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// Internal cron — fires automatically if this process stays running 24/7.
cron.schedule(
  "0 8 * * *",
  () => {
    console.log("Internal cron: running 8am daily send...");
    sendDailyReportToAll().catch((err) => console.error("Daily send failed:", err));
  },
  { timezone: TIMEZONE }
);

// Internal cron backup for lift status — fires every 15 minutes if this
// process stays running 24/7. The external cron-job.org trigger (see
// README) is still recommended since free hosting tiers can sleep.
cron.schedule(
  "*/15 * * * *",
  () => {
    refreshLiftCache().catch((err) => console.error("Internal lift refresh failed:", err.message));
  },
  { timezone: TIMEZONE }
);

app.listen(PORT, () => {
  console.log(`Falls Creek report server running on port ${PORT}`);
});
