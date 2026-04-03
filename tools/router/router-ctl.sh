#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

ROUTER_PORT="${ROUTER_PORT:-${PORT:-43177}}"
ROUTER_BIND_HOST="${ROUTER_BIND_HOST:-${ROUTER_HOST:-0.0.0.0}}"
ROUTER_CONNECT_HOST="${ROUTER_CONNECT_HOST:-127.0.0.1}"
BASE_URL="http://${ROUTER_CONNECT_HOST}:${ROUTER_PORT}"
STATE_DIR="${XDG_STATE_HOME:-${HOME}/.local/state}/2026-router"
PID_FILE="${STATE_DIR}/router.pid"
LOG_FILE="${STATE_DIR}/router.log"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

need_cmd node
need_cmd curl

mkdir -p "$STATE_DIR"

healthcheck() {
  curl -fsS "${BASE_URL}/health" >/dev/null 2>&1
}

read_pid_file() {
  if [[ ! -f "$PID_FILE" ]]; then
    return 1
  fi

  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ "$pid" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$pid"
    return 0
  fi
  return 1
}

running_pid() {
  local pid
  pid="$(read_pid_file 2>/dev/null || true)"
  if [[ -z "$pid" ]]; then
    return 1
  fi
  if kill -0 "$pid" >/dev/null 2>&1; then
    printf '%s\n' "$pid"
    return 0
  fi
  return 1
}

listening_pids() {
  if ! command -v lsof >/dev/null 2>&1; then
    return 0
  fi
  lsof -tiTCP:"$ROUTER_PORT" -sTCP:LISTEN 2>/dev/null || true
}

kill_listeners() {
  local pids remaining
  pids="$(listening_pids)"
  if [[ -z "$pids" ]]; then
    return 0
  fi

  echo "killing existing listener(s) on port ${ROUTER_PORT}: $pids"
  kill $pids >/dev/null 2>&1 || true
  sleep 0.5

  remaining="$(listening_pids)"
  if [[ -n "$remaining" ]]; then
    kill -9 $remaining >/dev/null 2>&1 || true
  fi
}

start_router() {
  local pid

  if healthcheck; then
    echo "router already running at ${BASE_URL}"
    if pid="$(running_pid 2>/dev/null || true)"; then
      echo "pid: ${pid}"
    fi
    echo "log: ${LOG_FILE}"
    return 0
  fi

  if pid="$(running_pid 2>/dev/null || true)"; then
    kill "$pid" >/dev/null 2>&1 || true
    wait "$pid" 2>/dev/null || true
  fi

  rm -f "$PID_FILE"
  kill_listeners
  : >"$LOG_FILE"

  node - "$LOG_FILE" "$PID_FILE" "$ROUTER_BIND_HOST" "$ROUTER_PORT" <<'NODE'
const fs = require("fs");
const { spawn } = require("child_process");

const [logFile, pidFile, host, port] = process.argv.slice(2);
const outFd = fs.openSync(logFile, "a");
const child = spawn(process.execPath, ["router.cjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    ROUTER_HOST: host,
    ROUTER_PORT: port,
  },
  detached: true,
  stdio: ["ignore", outFd, outFd],
});

fs.writeFileSync(pidFile, `${child.pid}\n`);
child.unref();
NODE
  pid="$(read_pid_file)"

  for _ in $(seq 1 40); do
    if healthcheck; then
      echo "router running at ${BASE_URL} (bind ${ROUTER_BIND_HOST})"
      echo "pid: ${pid}"
      echo "log: ${LOG_FILE}"
      return 0
    fi
    sleep 0.25
  done

  echo "router failed to start" >&2
  cat "$LOG_FILE" >&2
  rm -f "$PID_FILE"
  exit 1
}

stop_router() {
  local pid

  pid="$(running_pid 2>/dev/null || true)"
  if [[ -n "$pid" ]]; then
    kill "$pid" >/dev/null 2>&1 || true
    wait "$pid" 2>/dev/null || true
  fi

  rm -f "$PID_FILE"
  kill_listeners
  echo "router stopped"
}

status_router() {
  local pid

  if healthcheck; then
    echo "router running at ${BASE_URL}"
    pid="$(running_pid 2>/dev/null || true)"
    if [[ -n "$pid" ]]; then
      echo "pid: ${pid}"
    fi
    echo "log: ${LOG_FILE}"
    return 0
  fi

  echo "router not running at ${BASE_URL} (bind ${ROUTER_BIND_HOST})" >&2
  return 1
}

show_logs() {
  touch "$LOG_FILE"
  cat "$LOG_FILE"
}

usage() {
  cat <<'EOF'
Usage: ./router-ctl.sh <start|stop|restart|status|logs>
EOF
}

COMMAND="${1:-start}"

case "$COMMAND" in
  start)
    start_router
    ;;
  stop)
    stop_router
    ;;
  restart)
    stop_router >/dev/null
    start_router
    ;;
  status)
    status_router
    ;;
  logs)
    show_logs
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac
