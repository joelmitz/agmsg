#!/usr/bin/env bash
set -euo pipefail

# Answer a blocked two-choice approval prompt after an operator has inspected it
# with peek. This action deliberately stays separate from peek: reads never type.
#
# A small TOCTOU window remains between the final terminal_peek and the native
# key operation because the terminal-driver ABI cannot make those two backend
# calls atomic. Keep them adjacent, never reuse an earlier peek, and fail closed
# on every state that cannot positively prove the marker is still visible.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/actas-lock.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/terminal-registry.sh"

die() { echo "approval: $*" >&2; exit 2; }
refuse() { local rc="$1"; shift; echo "approval: refusal=$*" >&2; exit "$rc"; }

TEAM="${1:-}"; MEMBER="${2:-}"; CHOICE="${3:-}"
[ $# -eq 3 ] && [ -n "$TEAM" ] && [ -n "$MEMBER" ] \
  || die "Usage: approval.sh <team> <member> <yes|no>"
case "$CHOICE" in yes|no) : ;; *) die "choice must be exactly 'yes' or 'no'; there is no default" ;; esac

REC="$(agmsg_spawn_path "$TEAM" "$MEMBER")"
[ -f "$REC" ] || refuse 13 "placement_unresolved team=$TEAM member=$MEMBER reason=no_placement_record"
IFS=$'\t' read -r REF _PROJECT _TYPE < "$REC" || true
[ -n "$REF" ] || refuse 13 "placement_unresolved team=$TEAM member=$MEMBER reason=empty_placement_record"

TERMINAL=""; PANE=""
TERMINAL="$(agmsg_terminal_ref_terminal "$REF")" || TERMINAL=""
PANE="$(agmsg_terminal_ref_id "$REF")" || PANE=""
[ -n "$TERMINAL" ] && [ -n "$PANE" ] \
  || refuse 13 "placement_unresolved team=$TEAM member=$MEMBER ref=$REF"

agmsg_terminal_load "$TERMINAL" \
  || refuse 13 "unsupported team=$TEAM member=$MEMBER terminal=$TERMINAL reason=driver_load_failed"
agmsg_terminal_has "$TERMINAL" capabilities approval \
  || refuse 13 "unsupported team=$TEAM member=$MEMBER terminal=$TERMINAL reason=approval_capability_missing"
declare -F terminal_approval >/dev/null 2>&1 \
  || refuse 13 "unsupported team=$TEAM member=$MEMBER terminal=$TERMINAL reason=approval_operation_missing"

SCREEN_FILE="$(mktemp "${TMPDIR:-/tmp}/agmsg-approval.XXXXXX")" \
  || refuse 11 "unreadable team=$TEAM member=$MEMBER terminal=$TERMINAL reason=tempfile_failed"
trap 'rm -f "$SCREEN_FILE"' EXIT
READ_RC=0
terminal_peek "$PANE" >"$SCREEN_FILE" || READ_RC=$?
if [ "$READ_RC" -ne 0 ]; then
  refuse "$READ_RC" "unreadable team=$TEAM member=$MEMBER terminal=$TERMINAL pane=$PANE read_rc=$READ_RC"
fi

# Case-sensitive and intentionally narrow: this is the marker measured by #1194.
if ! grep -F 'Do you want to proceed' "$SCREEN_FILE" >/dev/null 2>&1; then
  refuse 14 "stale team=$TEAM member=$MEMBER terminal=$TERMINAL pane=$PANE marker_missing"
fi

printf 'approval: prompt_begin team=%s member=%s choice=%s\n' "$TEAM" "$MEMBER" "$CHOICE"
cat "$SCREEN_FILE"
printf '\napproval: prompt_end\n'

WRITE_RC=0
terminal_approval "$PANE" "$CHOICE" >/dev/null || WRITE_RC=$?
[ "$WRITE_RC" -eq 0 ] \
  || refuse "$WRITE_RC" "write_failed team=$TEAM member=$MEMBER terminal=$TERMINAL pane=$PANE write_rc=$WRITE_RC"
printf 'approval: answered team=%s member=%s choice=%s terminal=%s pane=%s\n' \
  "$TEAM" "$MEMBER" "$CHOICE" "$TERMINAL" "$PANE"
