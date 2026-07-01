#!/usr/bin/env node
// Minimal always-on proxy monitor backend. Zero external dependencies —
// only Node built-ins. Runs a continuous check loop (real 5-30s cadence,
// not gated by GitHub Actions' scheduler) and serves a small JSON API for
// the GitHub Pages dashboard to poll directly.
//
// Config via env (see .env.example):
//   PROXY_HOST, PROXY_HTTP_PORT, PROXY_SOCKS_PORT, PROXY_USER, PROXY_PASS  (required)
//   PAGE_PASSWORD       gates all API routes except /api/login (optional; if unset, API is open)
//   PORT                default 8787
//   CHECK_INTERVAL_SEC  default 15 (the "every 5-30s" cadence)
//   HISTORY_DAYS        default 7 (raw per-check history retention)
//   DATA_DIR            default ./data

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileP = promisify(execFile);

// ---------------------------------------------------------------- .env loader
// No dependency needed for this: parse KEY=VALUE lines from ./.env if
// present. Real environment variables (e.g. set by systemd) always win.
(function loadDotenv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const key = m[1];
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
})();

// ---------------------------------------------------------------- config
function need(name) {
  const v = process.env[name];
  if (!v) { console.error(`ERROR: ${name} is required (see .env.example)`); process.exit(1); }
  return v;
}
const CFG = {
  host: need('PROXY_HOST'),
  httpPort: need('PROXY_HTTP_PORT'),
  socksPort: need('PROXY_SOCKS_PORT'),
  user: need('PROXY_USER'),
  pass: need('PROXY_PASS'),
  pagePassword: process.env.PAGE_PASSWORD || '',
  port: Number(process.env.PORT || 8787),
  checkIntervalSec: Number(process.env.CHECK_INTERVAL_SEC || 15),
  historyDays: Number(process.env.HISTORY_DAYS || 7),
  dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
  timeoutSec: 20,
  speedTimeoutSec: 90,
  dlBytes: 8_000_000,
  ulBytes: 2_000_000,
  concN: 20,
  concBytes: 3_000_000,
  streamSeconds: 60,
  chunkSeconds: 15,
  sessionN: 10,
  cooldownSec: 30,
};
fs.mkdirSync(CFG.dataDir, { recursive: true });

const IP_URL = 'https://api.ipify.org';
const DOWN_URL = `https://speed.cloudflare.com/__down?bytes=${CFG.dlBytes}`;
const UP_URL = 'https://speed.cloudflare.com/__up';
const CONC_URL = `https://speed.cloudflare.com/__down?bytes=${CFG.concBytes}`;
const STREAM_URL = 'https://speed.cloudflare.com/__down?bytes=25000000';
const PROTOS = ['http', 'socks5'];

const uploadFile = path.join(CFG.dataDir, '.upload-body');
if (!fs.existsSync(uploadFile) || fs.statSync(uploadFile).size !== CFG.ulBytes) {
  fs.writeFileSync(uploadFile, Buffer.alloc(CFG.ulBytes));
}

// ---------------------------------------------------------------- curl helpers
function proxyUrl(proto) {
  return proto === 'http'
    ? `http://${CFG.user}:${CFG.pass}@${CFG.host}:${CFG.httpPort}`
    : `socks5h://${CFG.user}:${CFG.pass}@${CFG.host}:${CFG.socksPort}`;
}
async function curl(args, timeoutMs) {
  try {
    const { stdout } = await execFileP('curl', args, { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    return e.stdout || '';
  }
}
function toMbps(bytesPerSec) { return Math.round((Number(bytesPerSec || 0) * 8 / 1e6) * 100) / 100; }
function toMs(sec) { return Math.round(Number(sec || 0) * 1000); }

let runnerIp = '';
async function refreshRunnerIp() {
  runnerIp = (await curl(['-sS', '--max-time', '10', IP_URL], 12000)).trim();
}

// ---------------------------------------------------------------- measurements
async function measureQuick(proto) {
  const purl = proxyUrl(proto);
  const t = CFG.timeoutSec;
  const w = await curl(
    ['-sS', '-o', '/dev/null', '-x', purl, '-w', '%{http_code} %{time_connect} %{time_starttransfer} %{time_total}',
      '--max-time', String(t), IP_URL], (t + 5) * 1000);
  const [httpCode, tc, ts, tt] = (w.trim() || '000 0 0 0').split(/\s+/);
  const exitIp = (await curl(['-sS', '-x', purl, '--max-time', String(t), IP_URL], (t + 5) * 1000)).trim();
  const ok = httpCode === '200' && !!exitIp;
  const proxied = !!exitIp && exitIp !== runnerIp;

  const dlOut = await curl(
    ['-sS', '-o', '/dev/null', '-x', purl, '-w', '%{speed_download} %{size_download}',
      '--max-time', String(CFG.speedTimeoutSec), DOWN_URL], (CFG.speedTimeoutSec + 5) * 1000);
  const [dbps, dsize] = (dlOut.trim() || '0 0').split(/\s+/).map(Number);

  const ulOut = await curl(
    ['-sS', '-o', '/dev/null', '-x', purl, '--data-binary', `@${uploadFile}`,
      '-w', '%{speed_upload} %{size_upload}', '--max-time', String(CFG.speedTimeoutSec), UP_URL],
    (CFG.speedTimeoutSec + 5) * 1000);
  const [ubps, usize] = (ulOut.trim() || '0 0').split(/\s+/).map(Number);

  return {
    ok, exit_ip: exitIp, proxied,
    latency_ms: { connect: toMs(tc), ttfb: toMs(ts), total: toMs(tt) },
    download_mbps: toMbps(dbps), upload_mbps: toMbps(ubps),
    bytes: Math.round((dsize || 0) + (usize || 0)),
  };
}

async function measureSession(proto) {
  const purl = proxyUrl(proto);
  const ips = [];
  let ok = 0, sum = 0, min = Infinity, max = 0;
  for (let i = 0; i < CFG.sessionN; i++) {
    const w = await curl(['-sS', '-x', purl, '--max-time', String(CFG.timeoutSec), '-w', '\n%{time_total}', IP_URL],
      (CFG.timeoutSec + 5) * 1000);
    // Don't trim before splitting: curl still writes the -w line even on
    // failure, with an EMPTY first line (no body) - trimming the whole
    // blob first would eat that leading newline and shift the timing
    // value into the ip slot, making failures look like fake successes.
    const lines = w.split('\n');
    const ip = (lines[0] || '').trim();
    const tt = Number((lines[1] || '').trim() || 0);
    if (ip) {
      ok++; ips.push(ip);
      const ms = toMs(tt); sum += ms;
      if (ms < min) min = ms;
      if (ms > max) max = ms;
    }
  }
  return {
    requests: CFG.sessionN, success: ok,
    avg_ms: ok ? Math.round(sum / ok) : 0,
    min_ms: ok ? min : 0, max_ms: max,
    unique_ips: new Set(ips).size,
  };
}

async function measureConcurrency(proto) {
  const purl = proxyUrl(proto);
  const runs = Array.from({ length: CFG.concN }, () =>
    curl(['-sS', '-o', '/dev/null', '-x', purl, '--max-time', String(CFG.speedTimeoutSec),
      '-w', '%{http_code} %{speed_download}', CONC_URL], (CFG.speedTimeoutSec + 5) * 1000)
      .then((out) => (out.trim() || '000 0').split(/\s+/)));
  const rows = await Promise.all(runs);
  const ok = rows.filter((r) => r[0] === '200');
  const agg = rows.reduce((s, r) => s + Number(r[1] || 0), 0);
  const per = ok.reduce((s, r) => s + Number(r[1] || 0), 0);
  return {
    sessions: CFG.concN, success: ok.length,
    aggregate_mbps: toMbps(agg),
    per_session_mbps: ok.length ? toMbps(per / ok.length) : 0,
  };
}

async function measureStreaming(proto) {
  const purl = proxyUrl(proto);
  const chunks = Math.max(1, Math.floor(CFG.streamSeconds / CFG.chunkSeconds));
  const rates = [];
  for (let i = 0; i < chunks; i++) {
    const w = await curl(['-sS', '-o', '/dev/null', '-x', purl, '--max-time', String(CFG.chunkSeconds),
      '-w', '%{speed_download}', STREAM_URL], (CFG.chunkSeconds + 5) * 1000);
    rates.push(toMbps(Number(w.trim() || 0)));
  }
  const sorted = [...rates].sort((a, b) => a - b);
  const avg = rates.reduce((a, b) => a + b, 0) / rates.length;
  const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const stalls = rates.filter((r) => median > 0 && r < median * 0.5).length;
  return {
    window_sec: CFG.streamSeconds, chunks,
    avg_mbps: Math.round(avg * 100) / 100, min_mbps: sorted[0] || 0,
    median_mbps: Math.round(median * 100) / 100, stalls,
  };
}

// ---------------------------------------------------------------- state + persistence
const historyPath = path.join(CFG.dataDir, 'history.jsonl');
const latestPath = path.join(CFG.dataDir, 'latest.json');
let history = [];
let latest = { checked_at: null, t: 0, runner_ip: '', http: null, socks5: null };
const onDemand = { session: null, concurrency: null, streaming: null };
const cooldownUntil = { session: 0, concurrency: 0, streaming: 0 };

function loadHistory() {
  if (!fs.existsSync(historyPath)) return;
  const lines = fs.readFileSync(historyPath, 'utf8').split('\n').filter(Boolean);
  for (const l of lines) { try { history.push(JSON.parse(l)); } catch { /* skip bad line */ } }
  pruneHistory();
}
function pruneHistory() {
  const cutoff = Date.now() / 1000 - CFG.historyDays * 86400;
  history = history.filter((r) => r.t >= cutoff);
}
function appendHistory(row) {
  history.push(row);
  fs.appendFileSync(historyPath, JSON.stringify(row) + '\n');
}
let checksSinceRewrite = 0;
function maybeRewriteHistoryFile() {
  checksSinceRewrite++;
  if (checksSinceRewrite < 200) return;
  checksSinceRewrite = 0;
  pruneHistory();
  fs.writeFileSync(historyPath, history.map((r) => JSON.stringify(r)).join('\n') + (history.length ? '\n' : ''));
}
function writeAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
function saveLatest() { writeAtomic(latestPath, JSON.stringify(latest, null, 2)); }

loadHistory();
if (fs.existsSync(latestPath)) {
  try { latest = JSON.parse(fs.readFileSync(latestPath, 'utf8')); } catch { /* keep default */ }
}

// ---------------------------------------------------------------- check loop
let checking = false;
async function runQuickCheck() {
  if (checking) return; // don't overlap if a check runs long
  checking = true;
  try {
    const [httpR, socksR] = await Promise.all([measureQuick('http'), measureQuick('socks5')]);
    const t = Math.floor(Date.now() / 1000);
    const iso = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    latest = { checked_at: iso, t, runner_ip: runnerIp, http: httpR, socks5: socksR };
    saveLatest();
    appendHistory({ t, proto: 'http', ok: httpR.ok, ms: httpR.latency_ms.total, dl: httpR.download_mbps, ul: httpR.upload_mbps, bytes: httpR.bytes, ip: httpR.exit_ip });
    appendHistory({ t, proto: 'socks5', ok: socksR.ok, ms: socksR.latency_ms.total, dl: socksR.download_mbps, ul: socksR.upload_mbps, bytes: socksR.bytes, ip: socksR.exit_ip });
    maybeRewriteHistoryFile();
  } catch (e) {
    console.error('check failed:', e.message);
  } finally {
    checking = false;
  }
}
refreshRunnerIp().then(runQuickCheck);
setInterval(runQuickCheck, CFG.checkIntervalSec * 1000);
setInterval(refreshRunnerIp, 3600 * 1000);

// ---------------------------------------------------------------- summary aggregation
function ipSegments(proto) {
  const rows = history.filter((r) => r.proto === proto && r.ip).sort((a, b) => a.t - b.t);
  const segs = [];
  for (const r of rows) {
    const last = segs[segs.length - 1];
    if (last && last.ip === r.ip) last.end = r.t;
    else segs.push({ ip: r.ip, start: r.t, end: r.t });
  }
  return segs;
}
function buildSummary() {
  const nowS = Date.now() / 1000;
  const wins = [['24h', 86400], ['7d', 604800], ['30d', 2592000]];
  const uptime = {}, incidents = [], ipRotation = {};
  let todayBytes = 0, todayChecks = 0, monthBytes = 0, monthChecks = 0;
  const dayKey = new Date().toISOString().slice(0, 10);
  const monKey = new Date().toISOString().slice(0, 7);

  for (const p of PROTOS) {
    const rows = history.filter((r) => r.proto === p);
    uptime[p] = {};
    for (const [label, secs] of wins) {
      const inWin = rows.filter((r) => r.t >= nowS - secs);
      uptime[p][label] = inWin.length ? Math.round((100 * inWin.filter((r) => r.ok).length / inWin.length) * 100) / 100 : null;
    }
    // incidents
    const sorted = rows.slice().sort((a, b) => a.t - b.t);
    let start = null;
    for (const r of sorted) {
      if (!r.ok && start == null) start = r.t;
      if (r.ok && start != null) { incidents.push({ proto: p, start, end: r.t }); start = null; }
    }
    if (start != null) incidents.push({ proto: p, start, end: null });
    // ip rotation
    const segs = ipSegments(p);
    if (segs.length) {
      const current = segs[segs.length - 1];
      let avgRotationSec = null;
      if (segs.length >= 2) {
        const gaps = [];
        for (let i = 1; i < segs.length; i++) gaps.push(segs[i].start - segs[i - 1].start);
        avgRotationSec = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      }
      ipRotation[p] = {
        current_ip: current.ip, held_for_sec: Math.round(nowS - current.start),
        avg_rotation_sec: avgRotationSec == null ? null : Math.round(avgRotationSec),
        rotations_observed: segs.length - 1,
        log: segs.slice(0, -1).slice(-10).reverse().map((s) => ({ ip: s.ip, start: s.start, held_sec: Math.round(s.end - s.start) })),
      };
    } else {
      ipRotation[p] = { current_ip: null, held_for_sec: null, avg_rotation_sec: null, rotations_observed: 0, log: [] };
    }
  }
  for (const r of history) {
    const iso = new Date(r.t * 1000).toISOString();
    if (iso.slice(0, 10) === dayKey) { todayBytes += r.bytes || 0; todayChecks++; }
    if (iso.slice(0, 7) === monKey) { monthBytes += r.bytes || 0; monthChecks++; }
  }
  incidents.sort((a, b) => b.start - a.start);
  return {
    uptime, incidents: incidents.slice(0, 20), ip_rotation: ipRotation,
    usage: { today_bytes: todayBytes, today_checks: todayChecks, month_bytes: monthBytes, month_checks: monthChecks, checks_total: history.length / 2 },
  };
}

// ---------------------------------------------------------------- on-demand tests
async function runOnDemand(kind) {
  const now = Date.now();
  if (now < cooldownUntil[kind]) return { error: 'cooldown', retry_in_sec: Math.ceil((cooldownUntil[kind] - now) / 1000) };
  cooldownUntil[kind] = now + CFG.cooldownSec * 1000;
  const fn = kind === 'session' ? measureSession : kind === 'concurrency' ? measureConcurrency : measureStreaming;
  const [httpR, socksR] = await Promise.all([fn('http'), fn('socks5')]);
  const result = {
    checked_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    t: Math.floor(Date.now() / 1000),
    http: httpR, socks5: socksR,
  };
  onDemand[kind] = result;
  return result;
}

// ---------------------------------------------------------------- auth
function sha256Hex(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }
function checkAuth(req) {
  if (!CFG.pagePassword) return true;
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  return token === CFG.pagePassword;
}

// ---------------------------------------------------------------- HTTP server
function send(res, status, body, extraHeaders) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    ...extraHeaders,
  });
  res.end(json);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'OPTIONS') { send(res, 204, {}); return; }

  if (p === '/api/login' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let pass = '';
      try { pass = JSON.parse(body || '{}').password || ''; } catch { /* ignore */ }
      if (!CFG.pagePassword) { send(res, 200, { ok: true, open: true }); return; }
      send(res, 200, { ok: pass === CFG.pagePassword });
    });
    return;
  }

  if (!checkAuth(req)) { send(res, 401, { error: 'unauthorized' }); return; }

  if (p === '/api/latest' && req.method === 'GET') return send(res, 200, latest);
  if (p === '/api/summary' && req.method === 'GET') return send(res, 200, buildSummary());
  if (p === '/api/history' && req.method === 'GET') {
    const limit = Math.min(2000, Number(url.searchParams.get('limit') || 200));
    return send(res, 200, history.slice(-limit * 2)); // *2: both protocols per check
  }
  if (['session', 'concurrency', 'streaming'].includes(p.slice(5)) && req.method === 'GET') {
    return send(res, 200, onDemand[p.slice(5)] || { checked_at: null });
  }
  const runMatch = p.match(/^\/api\/run\/(session|concurrency|streaming)$/);
  if (runMatch && req.method === 'POST') {
    const kind = runMatch[1];
    try {
      const result = await runOnDemand(kind);
      return send(res, result.error ? 429 : 200, result);
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }
  send(res, 404, { error: 'not found' });
});

server.listen(CFG.port, () => {
  console.log(`proxy-monitor backend listening on :${CFG.port} (check interval ${CFG.checkIntervalSec}s, history ${CFG.historyDays}d)`);
});
