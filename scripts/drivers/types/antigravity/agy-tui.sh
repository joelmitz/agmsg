#!/usr/bin/env bash
set -euo pipefail

# agmsg Antigravity TUI launcher shim
HERE="$(cd "$(dirname "$0")" && pwd)"
PROJECT="${AGMSG_ANTIGRAVITY_PROJECT:-$HOME/projects/babelbiblenet-v2}"
TEAM="${AGMSG_ANTIGRAVITY_TEAM:-airsurf}"
ROLE="${AGMSG_ANTIGRAVITY_ROLE:-agy-tui}"
AGY="${AGMSG_ANTIGRAVITY_BIN:-$HOME/.local/bin/agy}"

exec bash "$HERE/antigravity-tui-monitor.sh" \
  --project "$PROJECT" \
  --team "$TEAM" \
  --name "$ROLE" \
  --agy "$AGY" "$@"
