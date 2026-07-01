// ---- config ---------------------------------------------------------------
// Set this to your backend's public URL (e.g. the Tailscale Funnel address
// printed when you run it — see backend/README.md). Must be reachable over
// HTTPS from the browser.
const API_BASE = "https://REPLACE-WITH-YOUR-TAILSCALE-FUNNEL-URL";
const PROTOS = ["http", "socks5"];
const REFRESH_MS = 10000; // how often the dashboard polls the backend (ms)

// ---- helpers ----------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const num = (v, d = 2) => (v == null ? "—" : Number(v).toFixed(d));
const TOKEN_KEY = "proxy-monitor-token";

function fmtBytes(b) {
  if (!b) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return (b / Math.pow(1024, i)).toFixed(i ? 1 : 0) + " " + u[i];
}
function ago(ts) {
  if (!ts) return "never";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}
function fmtDuration(sec) {
  if (sec == null) return "—";
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
function authHeaders() {
  const token = sessionStorage.getItem(TOKEN_KEY);
  return token ? { Authorization: "Bearer " + token } : {};
}
async function apiGet(path) {
  const r = await fetch(API_BASE + path, { headers: authHeaders(), cache: "no-store" });
  if (!r.ok) throw new Error(path + " " + r.status);
  return r.json();
}
async function apiPost(path) {
  const r = await fetch(API_BASE + path, { method: "POST", headers: authHeaders() });
  return r.json(); // backend returns a body even on 429 (cooldown) / errors
}

// ---- live status ------------------------------------------------------------
function renderStatus(latest) {
  $("updated").textContent =
    latest && latest.t ? `Updated ${ago(latest.t)}` : "Awaiting first check";
  for (const p of PROTOS) {
    const d = latest ? latest[p] : null;
    const badge = $(`${p}-badge`);
    if (!d) {
      badge.textContent = "no data"; badge.className = "badge";
      ["dl", "ul", "lat", "ip", "proxied"].forEach((k) => ($(`${p}-${k}`).textContent = "—"));
      continue;
    }
    badge.textContent = d.ok ? "operational" : "down";
    badge.className = "badge " + (d.ok ? "up" : "down");
    $(`${p}-dl`).textContent = num(d.download_mbps);
    $(`${p}-ul`).textContent = num(d.upload_mbps);
    $(`${p}-lat`).textContent = d.latency_ms ? d.latency_ms.total : "—";
    $(`${p}-ip`).textContent = d.exit_ip || "—";
    $(`${p}-proxied`).textContent = d.proxied ? "✓ yes" : "✗ no";
  }
}

// ---- uptime %, incidents, ip rotation, usage --------------------------------
// All computed server-side now (backend/server.js buildSummary()) since the
// full check history is far too large to ship to the browser every 10s at
// this cadence — the summary payload stays small regardless of history size.
function renderUptime(summary) {
  const wins = [["24h", "24h"], ["7d", "7d"], ["30d", "30d"]];
  for (const p of PROTOS) {
    const u = summary.uptime[p] || {};
    $(`${p}-uptime`).innerHTML = wins.map(([label, key]) => {
      const v = u[key];
      return `<div class="u"><div class="pct">${v == null ? "—" : v.toFixed(2) + "%"}</div><div class="win">${label}</div></div>`;
    }).join("");
  }
}
function renderIncidents(summary) {
  const list = summary.incidents || [];
  const el = $("incidents");
  if (!list.length) { el.innerHTML = `<li class="muted">No downtime recorded. 🎉</li>`; return; }
  el.innerHTML = list.map((i) => {
    const dur = i.end ? fmtDuration(i.end - i.start) : "ongoing";
    return `<li><b>${i.proto.toUpperCase()}</b> down — ${new Date(i.start * 1000).toLocaleString()} · ${dur}</li>`;
  }).join("");
}
function renderIpRotation(summary) {
  for (const p of PROTOS) {
    const r = summary.ip_rotation[p];
    const statsEl = $(`ip-stats-${p}`);
    const logEl = $(`ip-log-${p}`);
    if (!r || !r.current_ip) {
      statsEl.innerHTML = `<div><span>Exit IPs seen</span><b>—</b></div>`;
      logEl.innerHTML = `<li class="muted">No exit-IP data yet.</li>`;
      continue;
    }
    statsEl.innerHTML = [
      ["Current exit IP", r.current_ip],
      ["Held for", fmtDuration(r.held_for_sec)],
      ["Avg rotation interval", r.avg_rotation_sec != null ? fmtDuration(r.avg_rotation_sec) : "need 2+ rotations"],
      ["Rotations observed", r.rotations_observed],
    ].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join("");
    logEl.innerHTML = r.log.length
      ? r.log.map((s) => `<li><span>${new Date(s.start * 1000).toLocaleString()}</span><b>${s.ip} · held ${fmtDuration(s.held_sec)}</b></li>`).join("")
      : `<li class="muted">No rotations observed yet — same IP since tracking began.</li>`;
  }
}
function renderUsage(summary) {
  const u = summary.usage;
  $("today-usage").textContent = fmtBytes(u.today_bytes);
  $("today-split").textContent = `${u.today_checks} checks`;
  $("month-usage").textContent = fmtBytes(u.month_bytes);
  $("month-split").textContent = `${u.month_checks} checks`;
  $("checks-count").textContent = Math.round(u.checks_total);
}

// ---- downtime timeline (still needs raw per-check rows) --------------------
function renderTimeline(history) {
  for (const p of PROTOS) {
    const rows = history.filter((r) => r.proto === p).slice(-160);
    $(`tl-${p}`).innerHTML = rows.length
      ? rows.map((r) => `<div class="cell ${r.ok ? "up" : "down"}" title="${new Date(r.t * 1000).toLocaleString()} — ${r.ok ? "up" : "down"}"></div>`).join("")
      : `<span class="muted">No checks yet.</span>`;
  }
}

// ---- charts -------------------------------------------------------------
let charts = {};
function lineChart(canvasId, labels, byProto) {
  if (!window.Chart) return;
  const colors = { http: "#4f8cff", socks5: "#22c55e" };
  const cfg = {
    type: "line",
    data: {
      labels,
      datasets: PROTOS.map((p) => ({
        label: p.toUpperCase(),
        data: labels.map((_, i) => byProto[p][i] ?? null),
        borderColor: colors[p], backgroundColor: colors[p] + "22",
        tension: 0.25, pointRadius: 0, borderWidth: 2, fill: true, spanGaps: true,
      })),
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { ticks: { color: "#8a96bd", maxTicksLimit: 6, autoSkip: true }, grid: { color: "#25315c33" } },
        y: { beginAtZero: true, ticks: { color: "#8a96bd" }, grid: { color: "#25315c33" }, title: { display: true, text: "Mbps", color: "#8a96bd" } },
      },
      plugins: { legend: { labels: { color: "#e8ecf8" } } },
    },
  };
  if (charts[canvasId]) { charts[canvasId].data = cfg.data; charts[canvasId].update(); }
  else charts[canvasId] = new Chart($(canvasId), cfg);
}
function renderCharts(history) {
  const ts = [...new Set(history.map((r) => r.t))].sort((a, b) => a - b).slice(-150);
  const labels = ts.map((t) => new Date(t * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }));
  const idx = new Map(ts.map((t, i) => [t, i]));
  const series = (field) => {
    const out = {};
    for (const p of PROTOS) {
      out[p] = new Array(ts.length).fill(null);
      for (const r of history) if (r.proto === p && idx.has(r.t)) out[p][idx.get(r.t)] = r[field];
    }
    return out;
  };
  lineChart("chart-dl", labels, series("dl"));
  lineChart("chart-ul", labels, series("ul"));
}

// ---- on-demand tests ---------------------------------------------------------
function table(rows) {
  return `<table>${rows.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join("")}</table>`;
}
function renderOndemand(kind, data) {
  const el = $(`res-${kind}`);
  if (!data || !data.checked_at) { el.innerHTML = `<span class="muted">No run yet.</span>`; return; }
  const blocks = PROTOS.map((p) => {
    const d = data[p]; if (!d) return "";
    let rows = [];
    if (kind === "session")
      rows = [["Success", `${d.success}/${d.requests}`], ["Avg latency", `${d.avg_ms} ms`], ["Min/Max", `${d.min_ms}/${d.max_ms} ms`], ["Unique exit IPs", d.unique_ips]];
    else if (kind === "concurrency")
      rows = [["Success", `${d.success}/${d.sessions}`], ["Aggregate", `${d.aggregate_mbps} Mbps`], ["Per session", `${d.per_session_mbps} Mbps`]];
    else
      rows = [["Avg", `${d.avg_mbps} Mbps`], ["Min", `${d.min_mbps} Mbps`], ["Median", `${d.median_mbps} Mbps`], ["Stalls", d.stalls]];
    return `<div class="proto-h">${p.toUpperCase()}</div>${table(rows)}`;
  }).join("");
  el.innerHTML = `<div class="muted" style="margin-bottom:6px">${ago(data.t)}</div>${blocks}`;
}
async function runOndemand(kind, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Running… (this can take up to ~2 min)";
  try {
    const result = await apiPost(`/api/run/${kind}`);
    if (result.error === "cooldown") {
      $(`res-${kind}`).innerHTML = `<span class="muted">Just ran — try again in ${result.retry_in_sec}s.</span>`;
    } else {
      renderOndemand(kind, result);
    }
  } catch (e) {
    $(`res-${kind}`).innerHTML = `<span class="muted">Request failed: ${e.message}</span>`;
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}
document.querySelectorAll(".btn.run").forEach((b) => {
  b.addEventListener("click", () => runOndemand(b.dataset.test, b));
});
$("refresh").addEventListener("click", load);

// ---- main ---------------------------------------------------------------
async function load() {
  try {
    const [latest, summary, history] = await Promise.all([
      apiGet("/api/latest").catch(() => null),
      apiGet("/api/summary").catch(() => null),
      apiGet("/api/history?limit=200").catch(() => []),
    ]);
    renderStatus(latest);
    if (summary) {
      renderUptime(summary);
      renderIncidents(summary);
      renderIpRotation(summary);
      renderUsage(summary);
    }
    renderTimeline(history);
    renderCharts(history);
    for (const k of ["session", "concurrency", "streaming"]) {
      const d = await apiGet(`/api/${k}`).catch(() => null);
      renderOndemand(k, d);
    }
  } catch (e) {
    console.error(e);
    $("updated").textContent = "Error loading data";
  }
}

// Started by lock.js once login succeeds (no data is fetched before then).
let started = false;
window.startDashboard = function () {
  if (started) return;
  started = true;
  load();
  setInterval(load, REFRESH_MS);
};
