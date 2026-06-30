# TurboProxy Uptime Monitor

A tiny, **backend-free** uptime & performance monitor for TurboProxy's **HTTP** and **SOCKS5**
gateways. Everything runs on **GitHub Actions** (free) and a **static GitHub Pages** dashboard —
no server, no database, no paid API.

It routes real `curl` traffic *through* each proxy (separately) and measures:

- **Uptime** — reachability via the proxy's own exit, tracked independently for HTTP and SOCKS5
- **Live(-ish) speed** — download / upload Mbps (last measured, refreshed every few minutes)
- **Latency** — connect / TTFB / total
- **Downtime history** — 30-day timeline + incident list
- **On-demand tests** — session, concurrency, and streaming/"video" tests, run on a click

> **Honest limits.** GitHub cron has a 5-minute floor and is best-effort, so "live" means
> *last measured, auto-refreshed ~every few minutes* — not a continuous meter. Portal figures
> (Sessions, Connections, Assigned Proxies, portal "Today Usage") live inside TurboProxy and need
> its login/API; this dashboard shows **independently measured** equivalents only.

---

## How it works

```
GitHub Actions (cron + manual)  →  scripts/monitor.sh  →  curl through HTTP & SOCKS5
        │                                                   (Cloudflare/ipify test endpoints)
        ▼
   docs/data/*.json   (committed back by the workflow with the built-in GITHUB_TOKEN)
        ▼
GitHub Pages (/docs)  →  static dashboard fetches the JSON and renders it
```

- **`scripts/monitor.sh`** — all test logic. Modes: `quick` (cron), `session`, `concurrency`, `streaming`.
- **`.github/workflows/monitor.yml`** — runs the script, commits results. Cron runs `quick`; the
  manual *Run workflow* button runs whichever test you pick.
- **`docs/`** — the static dashboard (`index.html` / `style.css` / `app.js`) + `docs/data/` JSON.

---

## Setup (one-time)

You must do these — they can't be automated from here:

1. **Make the repo public** (unlimited free Actions minutes; private repos cap at 2,000/month).

2. **Add repository secrets** — Settings → Secrets and variables → Actions → *New repository secret*:
   | Secret | Value |
   |---|---|
   | `PROXY_USER` | your proxy username (e.g. `maistest017685`) |
   | `PROXY_PASS` | your proxy password |

   Host/ports are **not** secret and live in the workflow (`proxy.fidobox.us`, `10000`, `10001`).
   Change them there if your gateway differs.

3. **Enable GitHub Pages** — Settings → Pages → *Deploy from a branch* → branch
   `claude/turboproxy-uptime-monitor-bgqjwe` (or `main` after merge), folder `/docs`.

4. **Seed the data** — Actions tab → *Proxy Monitor* → *Run workflow* → `quick`.
   After it finishes, open your Pages URL.

5. **(Optional) edit `REPO` in `docs/app.js`** if the repo path changes — it's only used for the
   on-demand "Run workflow" deep links.

---

## Running tests on demand

The dashboard's **Run** buttons open the workflow's *Run workflow* page on GitHub. Pick the test
type (`session` / `concurrency` / `streaming`) and click **Run workflow**. Results commit back and
appear on the dashboard within ~1 minute (it auto-refreshes).

> A public web page can't trigger a workflow without exposing a secret token, so the buttons
> deep-link to GitHub's built-in trigger instead of firing directly. That's the only safe free option.

| Test | What it measures |
|---|---|
| **quick** | reachability, latency, download/upload speed (runs automatically on cron) |
| **session** | N sequential requests — success rate, latency spread, exit-IP stability |
| **concurrency** | N parallel sessions — success rate, aggregate & per-session throughput |
| **streaming** | sustained pull over a window — avg/min Mbps and stall (buffering) count |

Tune sizes/counts via env in `.github/workflows/monitor.yml` (e.g. `CONC_N`, `STREAM_SECONDS`).

---

## Local testing

```bash
export PROXY_USER=... PROXY_PASS=...
bash scripts/monitor.sh quick      # writes docs/data/latest.json + appends history.jsonl
```

Requires `curl` (with SOCKS5 support — standard) and `jq`.
