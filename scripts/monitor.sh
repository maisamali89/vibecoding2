#!/usr/bin/env bash
# Proxy uptime / performance monitor.
#
# Runs curl-based tests THROUGH the HTTP and SOCKS5 proxies (separately) and
# writes JSON results into $DATA_DIR for the static dashboard to read.
#
# Usage:  scripts/monitor.sh <mode>
#   quick        reachability + latency + down/up speed   (cheap; runs on cron)
#   session      N sequential requests, exit-IP stability  (on-demand)
#   concurrency  N parallel sessions, success rate + agg.   (on-demand)
#   streaming    sustained pull, avg Mbps + stall count     (on-demand)
#
# Config via env:
#   PROXY_HOST        required (e.g. proxy.example.com)
#   PROXY_HTTP_PORT   required
#   PROXY_SOCKS_PORT  required
#   PROXY_USER        required
#   PROXY_PASS        required
#   DATA_DIR          default: docs/data
#   TIMEOUT           per-request timeout sec (default 20)
#   DL_BYTES/UL_BYTES quick speed sizes (default 8MB / 2MB)
#   CONC_N            concurrency sessions (default 20)
#   STREAM_SECONDS    streaming window sec (default 60)
#   CHUNK_SECONDS     per-chunk timeout within the streaming window (default 15)

set -uo pipefail

MODE="${1:-quick}"

DATA_DIR="${DATA_DIR:-docs/data}"
TIMEOUT="${TIMEOUT:-20}"
SPEED_TIMEOUT="${SPEED_TIMEOUT:-90}"
DL_BYTES="${DL_BYTES:-8000000}"
UL_BYTES="${UL_BYTES:-2000000}"
CONC_N="${CONC_N:-20}"
CONC_BYTES="${CONC_BYTES:-3000000}"
STREAM_SECONDS="${STREAM_SECONDS:-60}"
CHUNK_SECONDS="${CHUNK_SECONDS:-15}"
SESSION_N="${SESSION_N:-10}"

DOWN_URL="https://speed.cloudflare.com/__down?bytes=${DL_BYTES}"
UP_URL="https://speed.cloudflare.com/__up"
STREAM_URL="https://speed.cloudflare.com/__down?bytes=25000000"
IP_URL="https://api.ipify.org"

if [[ -z "${PROXY_HOST:-}" || -z "${PROXY_HTTP_PORT:-}" || -z "${PROXY_SOCKS_PORT:-}" \
      || -z "${PROXY_USER:-}" || -z "${PROXY_PASS:-}" ]]; then
  echo "ERROR: PROXY_HOST, PROXY_HTTP_PORT, PROXY_SOCKS_PORT, PROXY_USER and PROXY_PASS must all be set" >&2
  exit 1
fi

mkdir -p "$DATA_DIR"
export PROXY_USER PROXY_PASS PROXY_HOST PROXY_HTTP_PORT PROXY_SOCKS_PORT TIMEOUT

now_epoch() { date -u +%s; }
now_iso()   { date -u +%FT%TZ; }

# Build the curl -x proxy URL for a protocol ("http" | "socks5").
proxy_url() {
  case "$1" in
    http)   printf 'http://%s:%s@%s:%s'      "$PROXY_USER" "$PROXY_PASS" "$PROXY_HOST" "$PROXY_HTTP_PORT" ;;
    socks5) printf 'socks5h://%s:%s@%s:%s'   "$PROXY_USER" "$PROXY_PASS" "$PROXY_HOST" "$PROXY_SOCKS_PORT" ;;
  esac
}

# bytes/sec -> Mbps, 2 dp
to_mbps() { awk -v b="${1:-0}" 'BEGIN{printf "%.2f", (b*8)/1e6}'; }
# seconds -> ms, integer
to_ms()   { awk -v s="${1:-0}" 'BEGIN{printf "%d", s*1000}'; }

RUNNER_IP="$(curl -sS --max-time 10 "$IP_URL" 2>/dev/null || echo '')"

# ---------------------------------------------------------------- quick
# Per-protocol snapshot: reachability, latency, download + upload speed.
measure_quick() {
  local proto="$1" purl rc w http_code tc ts tt exit_ip dl ul dbps ubps bytes ok proxied
  purl="$(proxy_url "$proto")"

  w="$(curl -sS -o /dev/null -x "$purl" \
        -w '%{http_code} %{time_connect} %{time_starttransfer} %{time_total}' \
        --max-time "$TIMEOUT" "$IP_URL" 2>/dev/null)"; rc=$?
  read -r http_code tc ts tt <<<"${w:-000 0 0 0}"

  exit_ip="$(curl -sS -x "$purl" --max-time "$TIMEOUT" "$IP_URL" 2>/dev/null || echo '')"

  if [[ "$rc" -eq 0 && "$http_code" == "200" && -n "$exit_ip" ]]; then ok=true; else ok=false; fi
  if [[ -n "$exit_ip" && "$exit_ip" != "$RUNNER_IP" ]]; then proxied=true; else proxied=false; fi

  dl="$(curl -sS -o /dev/null -x "$purl" -w '%{speed_download} %{size_download}' \
        --max-time "$SPEED_TIMEOUT" "$DOWN_URL" 2>/dev/null)"
  ul="$(head -c "$UL_BYTES" /dev/zero | curl -sS -o /dev/null -x "$purl" --data-binary @- \
        -w '%{speed_upload} %{size_upload}' --max-time "$SPEED_TIMEOUT" "$UP_URL" 2>/dev/null)"
  read -r dbps dsize <<<"${dl:-0 0}"
  read -r ubps usize <<<"${ul:-0 0}"
  dbps="${dbps:-0}"; dsize="${dsize:-0}"; ubps="${ubps:-0}"; usize="${usize:-0}"
  bytes=$(( ${dsize%.*} + ${usize%.*} ))

  jq -n \
    --argjson ok "$ok" --arg ip "$exit_ip" --argjson proxied "$proxied" \
    --argjson connect "$(to_ms "$tc")" --argjson ttfb "$(to_ms "$ts")" --argjson total "$(to_ms "$tt")" \
    --arg dmbps "$(to_mbps "$dbps")" --arg umbps "$(to_mbps "$ubps")" --argjson bytes "$bytes" \
    '{ok:$ok, exit_ip:$ip, proxied:$proxied,
      latency_ms:{connect:$connect, ttfb:$ttfb, total:$total},
      download_mbps:($dmbps|tonumber), upload_mbps:($umbps|tonumber), bytes:$bytes}'
}

run_quick() {
  local http socks t iso
  http="$(measure_quick http)"
  socks="$(measure_quick socks5)"
  t="$(now_epoch)"; iso="$(now_iso)"

  jq -n --arg iso "$iso" --argjson t "$t" --arg rip "$RUNNER_IP" \
    --argjson http "$http" --argjson socks "$socks" \
    '{checked_at:$iso, t:$t, runner_ip:$rip, http:$http, socks5:$socks}' \
    > "$DATA_DIR/latest.json"

  # append compact history rows (one per protocol)
  for p in http socks5; do
    src=$([ "$p" = http ] && echo "$http" || echo "$socks")
    echo "$src" | jq -c --argjson t "$t" --arg proto "$p" \
      '{t:$t, proto:$proto, ok:.ok, ms:.latency_ms.total,
        dl:.download_mbps, ul:.upload_mbps, bytes:.bytes, ip:.exit_ip}' \
      >> "$DATA_DIR/history.jsonl"
  done

  prune_history
  echo "quick: http ok=$(echo "$http"|jq .ok) socks5 ok=$(echo "$socks"|jq .ok)"
}

# Keep only the last 30 days of history rows.
prune_history() {
  local f="$DATA_DIR/history.jsonl" cutoff
  [[ -f "$f" ]] || return 0
  cutoff=$(( $(now_epoch) - 30*24*3600 ))
  awk -v c="$cutoff" 'NR{ if (match($0,/"t":[0-9]+/)) { ts=substr($0,RSTART+4,RLENGTH-4)+0; if (ts>=c) print } }' \
    "$f" > "$f.tmp" && mv "$f.tmp" "$f"
}

# ---------------------------------------------------------------- session
measure_session() {
  local proto="$1" purl i rc tt ok_count=0 sum_ms=0 min_ms=999999 max_ms=0 ms ips=()
  purl="$(proxy_url "$proto")"
  for ((i=0; i<SESSION_N; i++)); do
    w="$(curl -sS -x "$purl" --max-time "$TIMEOUT" -w '\n%{time_total}' "$IP_URL" 2>/dev/null)"; rc=$?
    ip="$(echo "$w" | head -n1)"; tt="$(echo "$w" | tail -n1)"
    if [[ "$rc" -eq 0 && -n "$ip" ]]; then
      ok_count=$((ok_count+1)); ips+=("$ip")
      ms="$(to_ms "$tt")"; sum_ms=$((sum_ms+ms))
      (( ms<min_ms )) && min_ms=$ms; (( ms>max_ms )) && max_ms=$ms
    fi
  done
  local avg=0 uniq=0
  (( ok_count>0 )) && avg=$((sum_ms/ok_count)) && min_ms=$min_ms || min_ms=0
  uniq="$(printf '%s\n' "${ips[@]:-}" | sort -u | grep -c . )"
  jq -n --argjson n "$SESSION_N" --argjson ok "$ok_count" \
    --argjson avg "$avg" --argjson min "$min_ms" --argjson max "$max_ms" --argjson uniq "$uniq" \
    '{requests:$n, success:$ok, avg_ms:$avg, min_ms:$min, max_ms:$max, unique_ips:$uniq}'
}

run_session() {
  jq -n --arg iso "$(now_iso)" --argjson t "$(now_epoch)" \
    --argjson http "$(measure_session http)" --argjson socks "$(measure_session socks5)" \
    '{checked_at:$iso, t:$t, requests:($http.requests), http:$http, socks5:$socks}' \
    > "$DATA_DIR/session.json"
  echo "session done"
}

# ---------------------------------------------------------------- concurrency
measure_concurrency() {
  local proto="$1" purl tmp ok agg per
  purl="$(proxy_url "$proto")"
  tmp="$(mktemp)"
  export CC_PURL="$purl" CC_URL="https://speed.cloudflare.com/__down?bytes=${CONC_BYTES}" CC_T="$SPEED_TIMEOUT"
  seq "$CONC_N" | xargs -P "$CONC_N" -I {} sh -c '
    out="$(curl -sS -o /dev/null -x "$CC_PURL" --max-time "$CC_T" \
      -w "%{http_code} %{speed_download} %{exitcode}" "$CC_URL" 2>/dev/null)"
    echo "${out:-000 0 -1}"
  ' > "$tmp"
  ok="$(grep -c '^200 ' "$tmp" || true)"
  agg="$(awk '{s+=$2} END{printf "%.2f", (s*8)/1e6}' "$tmp")"
  per="$(awk -v ok="$ok" '$1=="200"{s+=$2} END{if(ok>0) printf "%.2f", (s*8)/1e6/ok; else print 0}' "$tmp")"
  echo "concurrency debug ($proto): $(awk '$1!="200"{print "curl_exit="$3}' "$tmp" | sort | uniq -c | tr '\n' ' ')" >&2
  rm -f "$tmp"
  jq -n --argjson n "$CONC_N" --argjson ok "${ok:-0}" \
    --arg agg "$agg" --arg per "$per" \
    '{sessions:$n, success:$ok, aggregate_mbps:($agg|tonumber), per_session_mbps:($per|tonumber)}'
}

run_concurrency() {
  jq -n --arg iso "$(now_iso)" --argjson t "$(now_epoch)" \
    --argjson http "$(measure_concurrency http)" --argjson socks "$(measure_concurrency socks5)" \
    '{checked_at:$iso, t:$t, sessions:($http.sessions), http:$http, socks5:$socks}' \
    > "$DATA_DIR/concurrency.json"
  echo "concurrency done"
}

# ---------------------------------------------------------------- streaming
# Sustained pull split into CHUNK_SECONDS-long chunks; flag chunks below 50% of the
# median as stalls. Each chunk needs enough headroom past connect/TLS overhead to
# show real throughput - too short a chunk (e.g. 5-6s) on a slow proxy means most
# of the window is connection setup, so it reports ~0 Mbps even on success.
measure_streaming() {
  local proto="$1" purl chunks i rc rates=() tmp codes
  purl="$(proxy_url "$proto")"
  chunks=$(( STREAM_SECONDS/CHUNK_SECONDS )); (( chunks<1 )) && chunks=1
  tmp="$(mktemp)"; codes="$(mktemp)"
  for ((i=0; i<chunks; i++)); do
    w="$(curl -sS -o /dev/null -x "$purl" --max-time "$CHUNK_SECONDS" \
            -w '%{speed_download} %{exitcode} %{http_code}' "$STREAM_URL" 2>/dev/null)"
    read -r spd ec hc <<<"${w:-0 -1 000}"
    echo "$(to_mbps "${spd:-0}")" >> "$tmp"
    echo "exit=$ec http=$hc" >> "$codes"
  done
  echo "streaming debug ($proto): $(sort "$codes" | uniq -c | tr '\n' ' ')" >&2
  rm -f "$codes"
  local avg min stalls total_bytes
  avg="$(awk '{s+=$1} END{if(NR>0) printf "%.2f", s/NR; else print 0}' "$tmp")"
  min="$(sort -n "$tmp" | head -n1)"
  # median for stall threshold
  med="$(sort -n "$tmp" | awk '{a[NR]=$1} END{print (NR%2)? a[int(NR/2)+1] : (a[NR/2]+a[NR/2+1])/2}')"
  stalls="$(awk -v m="$med" '{ if (m>0 && $1 < m*0.5) c++ } END{print c+0}' "$tmp")"
  rm -f "$tmp"
  jq -n --argjson sec "$STREAM_SECONDS" --arg avg "$avg" --arg min "${min:-0}" \
    --arg med "${med:-0}" --argjson stalls "${stalls:-0}" --argjson chunks "$chunks" \
    '{window_sec:$sec, chunks:$chunks, avg_mbps:($avg|tonumber),
      min_mbps:($min|tonumber), median_mbps:($med|tonumber), stalls:$stalls}'
}

run_streaming() {
  jq -n --arg iso "$(now_iso)" --argjson t "$(now_epoch)" \
    --argjson http "$(measure_streaming http)" --argjson socks "$(measure_streaming socks5)" \
    '{checked_at:$iso, t:$t, window_sec:($http.window_sec), http:$http, socks5:$socks}' \
    > "$DATA_DIR/streaming.json"
  echo "streaming done"
}

case "$MODE" in
  quick)       run_quick ;;
  session)     run_session ;;
  concurrency) run_concurrency ;;
  streaming)   run_streaming ;;
  *) echo "Unknown mode: $MODE" >&2; exit 2 ;;
esac
