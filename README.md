# Proxy Uptime Monitor

A real-time uptime & performance monitor for a proxy's **HTTP** and **SOCKS5** gateways,
tracked completely independently. A small backend (that you run) checks continuously —
every 5-30 seconds — and a static dashboard on GitHub Pages polls it live.

It routes real `curl` traffic *through* each proxy (separately) and measures:

- **Uptime** — reachability via the proxy's own exit, tracked independently for HTTP and SOCKS5
- **Live speed** — download / upload Mbps, refreshed every `REFRESH_MS` (10s by default)
- **Accurate downtime** — since checks run continuously, "down for 17 minutes" is a real
  measured duration, not a gap between two far-apart snapshots
- **Latency** — connect / TTFB / total
- **Exit IP rotation** — current IP, how long it's been held, observed rotation interval
- **On-demand tests** — session, concurrency, and streaming/"video" tests, run live on click

> Portal figures (Sessions, Connections, Assigned Proxies, portal "Today Usage") live inside the
> proxy provider's own customer portal and need its login/API; this dashboard shows
> **independently measured** equivalents only.

---

## How it works

```
backend/server.js (your always-on server)  →  curl through HTTP & SOCKS5, every 5-30s
        │                                       (Cloudflare/ipify test endpoints)
        ▼
  in-memory + local JSON (no git commits, no GitHub Actions)
        ▼
Tailscale Funnel (public HTTPS URL, no static IP needed)
        ▼
GitHub Pages (/docs)  →  static dashboard polls the backend's API directly and renders it
```

**Why a backend, and why this replaces GitHub Actions:** this project originally ran entirely on
GitHub Actions cron + committed JSON files. Real measurement showed GitHub's `schedule:` trigger
firing only ~8 times over 18 hours instead of the configured every-10-minutes — it drops the vast
majority of ticks at short intervals, a hard platform limit, not a bug in the workflow. That also
made downtime duration inherently inaccurate (you can only know "down sometime between check N and
N+1", never a real number). A small always-on process removes both problems at once: continuous
checking isn't gated by any scheduler, and state transitions are timestamped to the second.
`.github/workflows/monitor.yml` still exists but its cron is disabled — nothing reads its output anymore.

- **`backend/server.js`** — the whole backend. Zero npm dependencies. See `backend/README.md` for
  setup, the systemd unit, and the Tailscale Funnel command.
- **`docs/`** — the static dashboard (`index.html` / `style.css` / `app.js` / `lock.js`). Polls the
  backend's API instead of reading files out of the repo.
- **`scripts/monitor.sh`** — the original Actions-only implementation. No longer wired up, kept for
  reference / as a fallback if you ever want to go back to the git-committed-JSON approach.

---

## Setup

1. **Run the backend** on a machine that can reach your proxy — see **`backend/README.md`** for
   the full walkthrough (`.env` config, systemd unit, `tailscale funnel` command).

2. **Point the dashboard at it** — edit `docs/app.js`:
   ```js
   const API_BASE = "https://your-machine.your-tailnet.ts.net";
   ```
   Commit and push; GitHub Pages redeploys automatically.

3. **Enable GitHub Pages** (if not already) — Settings → Pages → *Deploy from a branch* → branch
   `claude/turboproxy-uptime-monitor-bgqjwe` (or `main` after merge), folder `/docs`.

4. Open the Pages URL and enter the password you set as `PAGE_PASSWORD` in `backend/.env`.

### Auth, for real this time

Unlike the old GitHub-Pages-only version (where the "lock" only hid the UI — the underlying
`docs/data/*.json` files were still publicly fetchable by direct URL, since static hosting has no
per-file access control), the backend now verifies the password itself and requires it as a Bearer
token on every API call. The data is actually protected, not just the page.

---

## On-demand tests

Click a **Run** button on the dashboard — it POSTs straight to your backend, which runs the test
immediately and returns the result (no GitHub Actions round-trip, no ~1 minute wait). A 30s
cooldown per test type prevents accidental spamming of your own proxy.

| Test | What it measures |
|---|---|
| *(continuous)* | reachability, latency, download/upload speed — runs every `CHECK_INTERVAL_SEC` |
| **session** | N sequential requests — success rate, latency spread, exit-IP stability |
| **concurrency** | N parallel sessions — success rate, aggregate & per-session throughput |
| **streaming** | sustained pull over a window — avg/min Mbps and stall (buffering) count |

Tune sizes/counts via the constants near the top of `backend/server.js` (`CFG` object).

---

## Local testing

```bash
cd backend
cp .env.example .env   # fill in proxy host/ports/creds + PAGE_PASSWORD
node server.js
curl -X POST -H 'Content-Type: application/json' -d '{"password":"..."}' http://localhost:8787/api/login
```

Requires Node.js 18+ and `curl` (with SOCKS5 support — standard). No `npm install` needed.
