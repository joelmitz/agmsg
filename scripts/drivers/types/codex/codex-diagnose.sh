#!/usr/bin/env bash
set -euo pipefail

# Read-only three-layer Codex monitor diagnosis.
PROJECT="${1:?Usage: codex-diagnose.sh <project> <team> <agent>}"
TEAM="${2:?Missing team}"
AGENT="${3:?Missing agent}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
RUN_DIR="$SKILL_DIR/run"
source "$SCRIPT_DIR/../../../lib/hash.sh"
source "$SCRIPT_DIR/../../../lib/role-session.sh"
source "$SCRIPT_DIR/../../../lib/node.sh"

PROJECT="$(cd "$PROJECT" && pwd)"
HASH="$(printf '%s' "$PROJECT" | agmsg_sha1)"
PORT_FILE="$RUN_DIR/codex-app-server.$HASH.port"
SERVER_PID_FILE="$RUN_DIR/codex-app-server.$HASH.pid"
BASE="$RUN_DIR/codex-bridge.$TEAM.$AGENT"
BRIDGE_PID="$(cat "$BASE.pid" 2>/dev/null || true)"
BRIDGE_THREAD="$(cat "$BASE.thread" 2>/dev/null || true)"
BRIDGE_APP="$(cat "$BASE.appserver" 2>/dev/null || true)"
META="$BASE.meta"
PORT="$(cat "$PORT_FILE" 2>/dev/null || true)"
SERVER_PID="$(cat "$SERVER_PID_FILE" 2>/dev/null || true)"

agmsg_role_session_load "$TEAM" "$AGENT" 2>/dev/null || true
SEAT_THREAD="${AGMSG_ROLE_SESSION_UUID:-}"
NODE_BIN="$(agmsg_resolve_node 2>/dev/null || true)"
LOADED=""
if [ -n "$PORT" ] && [ -n "$NODE_BIN" ] && { command -v "$NODE_BIN" >/dev/null 2>&1 || [ -x "$NODE_BIN" ]; }; then
  LOADED="$("$NODE_BIN" "$SCRIPT_DIR/codex-bridge.js" --app-server "ws://127.0.0.1:$PORT" --print-loaded-threads --connect-timeout-ms 1500 --request-timeout-ms 1500 2>/dev/null || true)"
fi

TUI_PIDS=""
if [ -n "$PORT" ] && command -v ss >/dev/null 2>&1; then
  TUI_PIDS="$(ss -tnp 2>/dev/null | awk -v p=":$PORT" '$0 ~ p { print }' | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | sort -nu | tr '\n' ' ')"
fi
if [ -z "$TUI_PIDS" ]; then
  TUI_PIDS="$(ps -eo pid=,args= 2>/dev/null | awk -v p="--remote ws://127.0.0.1:$PORT" '$0 ~ /codex/ && $0 ~ p && $0 !~ /codex-bridge/ { print $1 }' | tr '\n' ' ')"
fi
TUI_PIDS="$(printf '%s' "$TUI_PIDS" | sed "s/\b$SERVER_PID\b//g; s/\b$BRIDGE_PID\b//g" | xargs 2>/dev/null || true)"

process_state="UNKNOWN"
[ -n "$TUI_PIDS" ] && process_state="MATCH"
app_state="UNKNOWN"
if [ -n "$PORT" ] && [ "$BRIDGE_APP" = "ws://127.0.0.1:$PORT" ] && [ -n "$SERVER_PID" ]; then
  app_state="MATCH"
elif [ -n "$BRIDGE_APP" ] || [ -n "$PORT" ]; then
  app_state="MISMATCH"
fi
thread_state="UNKNOWN"
if [ -n "$BRIDGE_THREAD" ] && [ -n "$SEAT_THREAD" ]; then
  if [ "$BRIDGE_THREAD" = "$SEAT_THREAD" ]; then thread_state="MATCH"; else thread_state="MISMATCH"; fi
fi
overall="MATCH"
for state in "$process_state" "$app_state" "$thread_state"; do
  [ "$state" = "MATCH" ] || { overall="$state"; [ "$state" = "MISMATCH" ] && break; }
done

echo "codex diagnosis: $overall"
echo "process: $process_state tui_pids=${TUI_PIDS:-unknown} app_server_pid=${SERVER_PID:-unknown} bridge_pid=${BRIDGE_PID:-unknown}"
echo "app-server: $app_state port=${PORT:-unknown} bridge_app=${BRIDGE_APP:-unknown}"
echo "thread: $thread_state seat=${SEAT_THREAD:-unknown} bridge=${BRIDGE_THREAD:-unknown}"
echo "loaded_threads: ${LOADED:-unknown}"
if [ -f "$META" ]; then
  awk -F= '/^(resume_error|self_test|self_test_status)=/ { print "meta: " $0 }' "$META"
fi
if [ -f "$BASE.log" ]; then
  echo "latest_bridge_log:"
  tail -n 5 "$BASE.log"
fi
[ "$overall" = "MATCH" ]
