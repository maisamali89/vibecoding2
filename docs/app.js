// ---- config -------------------------------------------------------------
// Used only for the on-demand "Run workflow" deep links.
const REPO = "maisamali89/vibecoding2";
const WORKFLOW = "monitor.yml";
const RUN_URL = `https://github.com/${REPO}/actions/workflows/${WORKFLOW}`;
const PROTOS = ["http", "socks5"];
const REFRESH_MS = 60000;

// ---- helpers ------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const num = (v, d = 2) => (v == null ? "—" : Number(v).toFixed(d));

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
async function getJSON(path) {
  const r = await fetch(path + "?_=" + Date.now(), { cache: "no-store" });
  if (!r.ok) throw new Error(path + " " + r.status);
  return r.json();
}
async function getLines(path) {
  const r = await fetch(path + "?_=" + Date.now(), { cache: "no-store" });
  if (!r.ok) return [];
  const txt = await r.text();
  return txt.split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

// ---- live status --------------------------------------------------------
function renderStatus(latest) {
  $("updated").textContent =
    latest && latest.t ? `Updated ${ago(latest.t)}` : "Awaiting first run";
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

// ---- uptime % + timeline + incidents + usage ---------------------------
function pct(rows) {
  if (!rows.length) return null;
  return (100 * rows.filter((r) => r.ok).length) / rows.length;
}
function renderUptime(history) {
  const nowS = Date.now() / 1000;
  const wins = [["24h", 86400], ["7d", 604800], ["30d", 2592000]];
  for (const p of PROTOS) {
    const rows = history.filter((r) => r.proto === p);
    const box = $(`${p}-uptime`);
    box.innerHTML = wins.map(([label, secs]) => {
      const v = pct(rows.filter((r) => r.t >= nowS - secs));
      return `<div class="u"><div class="pct">${v == null ? "—" : v.toFixed(2) + "%"}</div><div class="win">${label}</div></div>`;
    }).join("");
  }
}
function renderTimeline(history) {
  for (const p of PROTOS) {
    const rows = history.filter((r) => r.proto === p).slice(-160);
    $(`tl-${p}`).innerHTML = rows.length
      ? rows.map((r) => `<div class="cell ${r.ok ? "up" : "down"}" title="${new Date(r.t * 1000).toLocaleString()} — ${r.ok ? "up" : "down"}"></div>`).join("")
      : `<span class="muted">No checks yet.</span>`;
  }
}
function renderIncidents(history) {
  const list = [];
  for (const p of PROTOS) {
    const rows = history.filter((r) => r.proto === p).sort((a, b) => a.t - b.t);
    let start = null;
    for (let i = 0; i < rows.length; i++) {
      if (!rows[i].ok && start == null) start = rows[i].t;
      if (rows[i].ok && start != null) { list.push({ p, start, end: rows[i].t }); start = null; }
    }
    if (start != null) list.push({ p, start, end: null });
  }
  list.sort((a, b) => b.start - a.start);
  const el = $("incidents");
  if (!list.length) { el.innerHTML = `<li class="muted">No downtime recorded. 🎉</li>`; return; }
  el.innerHTML = list.slice(0, 20).map((i) => {
    const dur = i.end ? Math.round((i.end - i.start) / 60) + " min" : "ongoing";
    return `<li><b>${i.p.toUpperCase()}</b> down — ${new Date(i.start * 1000).toLocaleString()} · ${dur}</li>`;
  }).join("");
}
function renderUsage(history) {
  const now = new Date();
  const dayKey = now.toISOString().slice(0, 10);
  const monKey = now.toISOString().slice(0, 7);
  let today = 0, month = 0, tc = 0, mc = 0;
  for (const r of history) {
    const iso = new Date(r.t * 1000).toISOString();
    if (iso.slice(0, 10) === dayKey) { today += r.bytes || 0; tc++; }
    if (iso.slice(0, 7) === monKey) { month += r.bytes || 0; mc++; }
  }
  $("today-usage").textContent = fmtBytes(today);
  $("today-split").textContent = `${tc} checks`;
  $("month-usage").textContent = fmtBytes(month);
  $("month-split").textContent = `${mc} checks`;
  $("checks-count").textContent = history.length;
}

// ---- charts -------------------------------------------------------------
let charts = {};
// Category x-axis (formatted time labels) — avoids needing a Chart.js date adapter.
function lineChart(canvasId, labels, byProto, field) {
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
  // Build a shared timeline from the union of timestamps (HTTP & SOCKS5 share each run's t).
  const ts = [...new Set(history.map((r) => r.t))].sort((a, b) => a - b).slice(-150);
  const labels = ts.map((t) => new Date(t * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }));
  const idx = new Map(ts.map((t, i) => [t, i]));
  const series = (field) => {
    const out = {};
    for (const p of PROTOS) {
      out[p] = new Array(ts.length).fill(null);
      for (const r of history) if (r.proto === p && idx.has(r.t)) out[p][idx.get(r.t)] = r[field];
    }
    return out;
  };
  lineChart("chart-dl", labels, series("dl"), "dl");
  lineChart("chart-ul", labels, series("ul"), "ul");
}

// ---- on-demand results --------------------------------------------------
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

// ---- buttons ------------------------------------------------------------
document.querySelectorAll(".btn.run").forEach((b) => (b.href = RUN_URL));
$("refresh").addEventListener("click", load);

// ---- main ---------------------------------------------------------------
async function load() {
  try {
    const [latest, history] = await Promise.all([
      getJSON("data/latest.json").catch(() => null),
      getLines("data/history.jsonl"),
    ]);
    renderStatus(latest);
    renderUptime(history);
    renderTimeline(history);
    renderIncidents(history);
    renderUsage(history);
    renderCharts(history);
    for (const k of ["session", "concurrency", "streaming"]) {
      const d = await getJSON(`data/${k}.json`).catch(() => null);
      renderOndemand(k, d);
    }
  } catch (e) {
    console.error(e);
    $("updated").textContent = "Error loading data";
  }
}

// Started by lock.js once the password gate is passed (no data is fetched before then).
let started = false;
window.startDashboard = function () {
  if (started) return;
  started = true;
  load();
  setInterval(load, REFRESH_MS);
};
