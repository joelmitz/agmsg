#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(cd "$HERE/../../../.." && pwd)"
[ "$(uname -s)" = Linux ] || { echo 'Antigravity TUI monitor は初回対応では Linux 専用です' >&2; exit 1; }
[ -t 0 ] && [ -t 1 ] || { echo 'Antigravity TUI monitor は対話端末から起動してください' >&2; exit 1; }
source "$SKILL_DIR/scripts/lib/require-python3.sh"
agmsg_require_python3 'Antigravity TUI monitor' || exit 1
action=run
case "${1:-}" in
  status|stop) action="$1"; shift ;;
esac
exec python3 "$HERE/antigravity-tui-supervisor.py" --action "$action" "$@"
