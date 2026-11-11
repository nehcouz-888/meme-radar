#!/usr/bin/env bash
# FOMO LARGE-buy watcher control (alert-only, 0-credit WebSocket).
#   start | stop | status | ensure | disable | enable
# Pattern mirrors scan-accum/discovery-daemon.sh (supervisor + heartbeat stale kill).
set -euo pipefail
ROOT=/workspace/meme-radar-run/fomo-trader-watch
PIDFILE="$ROOT/state/watch.pid"
HB="$ROOT/state/heartbeat.json"
DISABLED="$ROOT/state/watch.disabled"
SUPLOG="$ROOT/logs/supervisor.log"
NODE22_BIN=/workspace/.nodejs/node-v22.23.0-linux-x64/bin
[ -x "$NODE22_BIN/node" ] && export PATH="$NODE22_BIN:$PATH"
STALE_S="${WATCH_STALE_S:-180}"   # WS should heartbeat every 30s; 3 min stale => restart
NODE_SCRIPT="$ROOT/fomo-trader-watch.mjs"

running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; }
hb_age() { if [ -f "$HB" ]; then echo $(( $(date +%s) - $(stat -c %Y "$HB") )); else echo 999999; fi; }

supervise() {
  echo $$ > "$PIDFILE"
  child=0
  trap 'if [ "$child" -gt 0 ]; then kill -TERM "$child" 2>/dev/null; wait "$child" 2>/dev/null; fi; rm -f "$PIDFILE"; echo "[sup $(date -Iseconds)] stopped" >> "$SUPLOG"; exit 0' TERM INT
  backoff=5
  while true; do
    [ -f "$DISABLED" ] && { echo "[sup $(date -Iseconds)] disabled; exit" >> "$SUPLOG"; rm -f "$PIDFILE"; exit 0; }
    started=$(date +%s)
    # Do not pass API key via argv/env dump; child reads ~/.config/fomo/api-key
    node "$NODE_SCRIPT" >> "$SUPLOG" 2>&1 &
    child=$!
    echo "[sup $(date -Iseconds)] node pid=$child" >> "$SUPLOG"
    while kill -0 "$child" 2>/dev/null; do
      sleep 30 & wait $! || true
      age=$(hb_age)
      if [ "$age" -gt "$STALE_S" ] && [ $(( $(date +%s) - started )) -gt "$STALE_S" ]; then
        echo "[sup $(date -Iseconds)] heartbeat stale ${age}s -> kill $child" >> "$SUPLOG"
        kill -TERM "$child" 2>/dev/null || true
        sleep 3
        kill -KILL "$child" 2>/dev/null || true
      fi
    done
    wait "$child" || true
    rc=$?
    child=0
    ran=$(( $(date +%s) - started ))
    [ "$ran" -gt 300 ] && backoff=5
    echo "[sup $(date -Iseconds)] node exited rc=$rc after ${ran}s; restart in ${backoff}s" >> "$SUPLOG"
    sleep "$backoff" & wait $! || true
    backoff=$(( backoff * 2 )); [ "$backoff" -gt 120 ] && backoff=120
  done
}

case "${1:-status}" in
  start)
    if [ -f "$DISABLED" ]; then echo "DISABLED (rm $DISABLED or: $0 enable)"; exit 0; fi
    if running; then echo "ALREADY_RUNNING pid=$(cat "$PIDFILE")"; exit 0; fi
    nohup setsid bash "$0" _supervise > /dev/null 2>&1 < /dev/null &
    sleep 1
    echo "STARTED supervisor pid=$(cat "$PIDFILE" 2>/dev/null || echo '?') at $(date -Iseconds)"
    ;;
  _supervise) supervise ;;
  stop)
    if running; then
      pid=$(cat "$PIDFILE")
      kill -TERM "$pid" 2>/dev/null || true
      for i in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
      kill -0 "$pid" 2>/dev/null && kill -KILL -- -"$pid" 2>/dev/null || true
      echo "STOPPED"
    else echo "NOT_RUNNING"; fi
    pkill -f "$NODE_SCRIPT" 2>/dev/null || true
    rm -f "$PIDFILE"
    ;;
  status)
    if running; then echo "RUNNING supervisor pid=$(cat "$PIDFILE") heartbeat_age=$(hb_age)s"; else echo "STOPPED"; fi
    [ -f "$DISABLED" ] && echo "DISABLED flag present"
    if [ -f "$HB" ]; then
      python3 - "$HB" <<'PYHB'
import json,sys
h=json.load(open(sys.argv[1]))
keys=["at","status","uptimeSec","tradersConfigured","wsOpenCount","seed"]
print("heartbeat:", {k:h.get(k) for k in keys if k in h})
conns=h.get("connections") or {}
if conns:
  open_h=sorted([k for k,v in conns.items() if v.get("wsOpen")])
  down_h=sorted([k for k,v in conns.items() if not v.get("wsOpen")])
  print(f"ws_open={len(open_h)}/{len(conns)} open=[{','.join(open_h)}] down=[{','.join(down_h)}]")
  alerts=sum(int(v.get("alerts") or 0) for v in conns.values())
  msgs=sum(int(v.get("messages") or 0) for v in conns.values())
  print(f"totals messages={msgs} alerts={alerts}")
else:
  print("heartbeat_legacy:", {k:h.get(k) for k in ["handle","wsOpen","messages","alerts","realtime","delaySeconds"] if k in h})
PYHB
    fi
    pending=$(find "$ROOT/alerts/pending" -name '*.txt' 2>/dev/null | wc -l | tr -d ' ')
    echo "pending_alerts=$pending queue=$ROOT/alerts/queue.jsonl"
    ;;
  ensure)
    if [ -f "$DISABLED" ]; then echo "DISABLED"; exit 0; fi
    if running; then
      age=$(hb_age)
      if [ "$age" -gt "$STALE_S" ]; then
        echo "STALE age=${age}s -> restart"
        bash "$0" stop
        sleep 1
        bash "$0" start
      else
        echo "OK running heartbeat_age=${age}s"
      fi
    else
      echo "NOT_RUNNING -> start"
      bash "$0" start
    fi
    ;;
  disable)
    bash "$0" stop || true
    touch "$DISABLED"
    echo "DISABLED"
    ;;
  enable)
    rm -f "$DISABLED"
    echo "ENABLED (run: $0 start)"
    ;;
  *)
    echo "usage: $0 {start|stop|status|ensure|disable|enable}"
    exit 2
    ;;
esac
