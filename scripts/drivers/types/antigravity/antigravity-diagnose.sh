#!/usr/bin/env bash
set -euo pipefail
# Read-only diagnosis shim for one Antigravity TUI seat.
#
# Kept out of the supervisor's own argparse on purpose: that parser dispatches
# stop/resume/ack/replay/reset-guard, all of which change state or signal a
# process. A read-only entry point sharing that door is one typo away from a
# write, and the door is the only thing keeping them apart.
HERE="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(cd "$HERE/../../../.." && pwd)"
source "$SKILL_DIR/scripts/lib/require-python3.sh"
agmsg_require_python3 'Antigravity diagnosis' || exit 1
# Same platform contract as the monitor: the process-identity checks below rest
# on POSIX primitives, and a host without them cannot answer the questions this
# script exists to ask.
case "$(uname -s)" in
  Linux|Darwin) ;;
  *) echo 'Antigravity diagnosis requires POSIX process primitives; this host is unsupported' >&2; exit 2 ;;
esac
exec python3 "$HERE/antigravity-diagnose.py" "$@"
