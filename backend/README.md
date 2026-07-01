# Proxy Monitor Backend

A small, always-on Node.js process that checks your HTTP and SOCKS5 proxies
continuously (every 5-30s, configurable) and serves the results as a JSON
API. This is what makes real-time updates and accurate downtime duration
possible — something a GitHub-Actions-only setup fundamentally can't do
(GitHub's `schedule:` trigger is best-effort and, in practice, drops most
ticks at short intervals — see the repo's git history/commit messages for
the measurements that led here).

Zero npm dependencies — only Node's built-ins and `curl` (already on every
Linux box). No `npm install` needed.

## Prerequisites

- Node.js 18+ (`node --version`)
- `curl`
- A machine that can reach your proxy (your Tailscale server, in this case)

## Setup

```bash
cd backend
cp .env.example .env
nano .env   # fill in PROXY_HOST/PORT/USER/PASS and PAGE_PASSWORD
node server.js
```

You should see:
```
proxy-monitor backend listening on :8787 (check interval 15s, history 7d)
```

Test it locally first:
```bash
curl -X POST -H 'Content-Type: application/json' \
  -d '{"password":"whatever-you-set"}' http://localhost:8787/api/login
# {"ok":true}
```

## Run it forever (systemd)

Create `/etc/systemd/system/proxy-monitor.service`:

```ini
[Unit]
Description=Proxy Monitor backend
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/vibecoding2/backend
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
User=youruser

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now proxy-monitor
sudo systemctl status proxy-monitor
journalctl -u proxy-monitor -f   # tail logs
```

`.env` is read automatically on startup (loaded from `backend/.env`), so
systemd doesn't need an `EnvironmentFile=` line — just make sure
`WorkingDirectory` points at the `backend/` folder.

## Expose it publicly (Tailscale Funnel)

Your server has no external IP, so the dashboard (on GitHub Pages) can't
reach it directly unless you expose it. Tailscale Funnel does this for
free, with no new service to set up:

```bash
# One-time, if not already done:
tailscale set --advertise-tags=tag:funnel   # or configure via the admin console
# Enable "HTTPS Certificates" and "Funnel" for this node in the Tailscale
# admin console (Settings) if you haven't already - one-time, a few clicks.

# Then, with the backend running on port 8787:
tailscale funnel 8787
```

This prints a public URL like `https://your-machine.your-tailnet.ts.net`.
That's what goes into `docs/app.js`'s `API_BASE` constant.

To keep the funnel running across reboots, run it as its own systemd unit
too, or use `tailscale funnel --bg 8787` (backgrounds it; check
`tailscale funnel status` to confirm).

## Point the dashboard at it

Edit `docs/app.js`:
```js
const API_BASE = "https://your-machine.your-tailnet.ts.net";
```
Commit and push — GitHub Pages redeploys automatically. The dashboard will
now poll your backend directly every `REFRESH_MS` (10s by default).

## Notes on the tradeoffs made here

- **Auth is a shared password**, sent as a Bearer token over HTTPS (via the
  Funnel's TLS). Fine for a personal dashboard behind a URL only you know;
  not meant to withstand a targeted attacker who obtains the password.
- **History retention defaults to 7 days** (`HISTORY_DAYS`), not 30 - at a
  15s interval that's already ~80,000 rows; keeping 30 days in memory scales
  linearly if you want it (raise `HISTORY_DAYS`), just costs more RAM.
- **On-demand tests (session/concurrency/streaming) run synchronously** -
  the HTTP request just takes as long as the test does (up to ~2 minutes
  for concurrency/streaming, same real-world timing as before). A 30s
  cooldown per test type prevents accidental hammering of your own proxy.
- If the process crashes or the machine reboots, systemd restarts it
  (`Restart=on-failure` + `enable`), so it comes back on its own. If the
  Funnel itself drops, the dashboard just shows "Error loading data" until
  it's back - there's no self-healing for that side, so it's worth
  periodically checking `tailscale funnel status`.
