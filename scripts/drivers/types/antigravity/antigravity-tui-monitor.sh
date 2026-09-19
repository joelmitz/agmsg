#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(cd "$HERE/../../../.." && pwd)"
source "$SKILL_DIR/scripts/lib/require-python3.sh"
agmsg_require_python3 'Antigravity TUI monitor' || exit 1
action=run
case "${1:-}" in
  status|stop|resume|reset-guard|ack|replay) action="$1"; shift ;;
esac
# Runs on Linux/macOS. Windows cannot provide the same POSIX process identity
# guarantees, so refuse instead of creating an unstoppable process.
case "$(uname -s)" in
  Linux|Darwin) ;;
  *) echo 'Antigravity TUI monitor requires POSIX process primitives; this host is unsupported' >&2; exit 1 ;;
esac
if [ "$action" = run ]; then
  [ -t 0 ] && [ -t 1 ] || { echo 'Antigravity TUI monitor must be started from an interactive terminal' >&2; exit 1; }
fi
exec python3 "$HERE/antigravity-tui-supervisor.py" --action "$action" "$@"
