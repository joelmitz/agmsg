#!/usr/bin/env bash
# Types one agmsg notice into an Antigravity seat's pane, for agmsgd's
# antigravity-nudge channel. It is poke.sh's pane path without its fallbacks:
# no "deliver as an agmsg message instead" and no retry loop (the daemon owns
# retries and backoff).
#
#   agy-nudge.sh <live|dry> <team> <name> --body -     (the one line comes on stdin)
#
# Neither mode runs safe-poke's draft recovery (see below).
# dry: every read and every safety check runs exactly as in live, but the
#      driver's write operations are replaced by no-ops, so nothing is typed.
# Exit codes are agmsg_safe_poke's: 0 sent (or, in dry, would have been sent),
# 14 draft, 15 input box not confirmed, 16 confirmation screen showing, 10/12
# the driver or pane is unreachable, 13 unsupported. Added here:
# 20 no placement record, 21 the record or driver does not resolve,
# 22 the seat is not an antigravity seat, 23 (live only) the line was typed but
# the Enter that submits it could not be sent or confirmed.
#
# Enter: on Windows, herdr's `agent prompt` puts the text in the input box and does
# not submit it (rules/agents/herdr.md; also seen with `pane send-text` on herdr
# 0.9.3), so in live mode, after a successful typing, ONE Enter is sent with
# `pane send-keys` (which works on any pane, agent-recognised or not). Only for herdr on Windows (AGMSG_AGY_NUDGE_ENTER=auto, the
# default); off = never; always = herdr on any OS. Never in dry mode, never repeated,
# and never retried here: whether an Enter on an already-empty agy input is harmless
# has not been measured, and a failed or unconfirmed Enter leaves the line in the
# box, which the daemon reports (exit 23) instead of typing the line a second time.
# Just before the Enter the screen is read again and the Enter is sent only if no
# confirmation screen shows and the input box holds exactly this line (else exit 23).
# After typing, the line NUDGE-TYPED is printed so the caller knows typing happened
# even if this script is later stopped.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC2034  # used by actas-lock.sh and safe-poke.sh
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/actas-lock.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/terminal-registry.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/type-registry.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/compat.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/safe-poke.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/resolve-project.sh"

MODE="${1:-}"; TEAM="${2:-}"; NAME="${3:-}"
[ "$MODE" = live ] || [ "$MODE" = dry ] || { echo "usage: agy-nudge.sh <live|dry> <team> <name> --body -" >&2; exit 2; }
[ -n "$TEAM" ] && [ -n "$NAME" ] && [ "${4:-}" = --body ] && [ "${5:-}" = - ] || { echo "usage: agy-nudge.sh <live|dry> <team> <name> --body -" >&2; exit 2; }
TEXT="$(cat)"
[ -n "$TEXT" ] || { echo "agy-nudge: empty body" >&2; exit 2; }

REC="$(agmsg_spawn_path "$TEAM" "$NAME")" || exit 20
[ -f "$REC" ] || exit 20
REF=""; _PROJ=""; _TYPE=""; _FENCE=""
IFS=$'\t' read -r REF _PROJ _TYPE _FENCE < "$REC" || true
[ -n "$REF" ] || exit 21
# The roster, not the record, says what this seat is (#1391): never type into a
# pane whose seat is not registered as antigravity.
# (tr: a native sqlite3 on Windows ends its lines with CR)
[ "$(agmsg_registered_type "$TEAM" "$NAME" 2>/dev/null | tr -d '\r' || true)" = antigravity ] || exit 22

TERMINAL="$(agmsg_terminal_ref_terminal "$REF")" || exit 21
BARE_ID="$(agmsg_terminal_ref_id "$REF")" || exit 21
[ -n "$TERMINAL" ] && [ -n "$BARE_ID" ] || exit 21
agmsg_terminal_load "$TERMINAL" >/dev/null 2>&1 || exit 21

# The #1384 recovery (save the person's draft to a file, clear the box, type, put
# the draft back) is for a caller that is itself a person or agent poking another.
# A daemon notice never clears or rewrites a draft, and must not write the draft
# to disk: without a focus signal safe-poke skips that recovery and refuses (14).
unset -f terminal_pane_focused

if [ "$MODE" = dry ]; then
  # Redefine every operation that changes a pane. safe-poke looks them up by
  # name at call time, so reads and checks still run against the real screen.
  terminal_poke() { return 0; }
  terminal_input_clear() { return 0; }
  terminal_input_type() { return 0; }
fi

INPUT_MARKER="$(agmsg_type_get antigravity input_prompt_marker)"
INPUT_BOXED="$(agmsg_type_get antigravity input_prompt_boxed)"
INPUT_REFUSE="$(agmsg_type_get antigravity input_refuse_screen)"
INPUT_MAX_TRAILING="$(agmsg_type_get antigravity input_max_trailing_lines)"
# A seat with no input-box rules must not be typed into blindly.
[ -n "$INPUT_MARKER" ] && [ "$TERMINAL" != plain ] || exit 13

RC=0
agmsg_safe_poke "$BARE_ID" "$TEXT" "$INPUT_MARKER" "$INPUT_BOXED" "$TEAM" "$NAME" \
  --retries 0 --refuse-screen "$INPUT_REFUSE" --max-trailing "$INPUT_MAX_TRAILING" >/dev/null 2>&1 || RC=$?
[ "$RC" -eq 0 ] || exit "$RC"
# A dry run ends here: it typed nothing and sends no Enter.
[ "$MODE" = live ] || exit 0
echo NUDGE-TYPED

WANT_ENTER=0
case "${AGMSG_AGY_NUDGE_ENTER:-auto}" in
  off) exit 0 ;;
  always) WANT_ENTER=1 ;;
  *) case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) WANT_ENTER=1 ;; esac ;;
esac
[ "$WANT_ENTER" -eq 1 ] && [ "$TERMINAL" = herdr ] || exit 0
declare -F _herdr_cli >/dev/null 2>&1 && declare -F _herdr_bare_of >/dev/null 2>&1 || exit 23

# The screen was judged BEFORE typing. Read it again now and send the Enter only when it
# is still safe: not a confirmation screen, the input box located, and its whole content
# exactly this notice line. Anything else (a screen that changed, another draft, an
# already-empty box, a box that cannot be read) gets no Enter and is reported (23).
_agy_nudge_norm() { printf '%s' "$1" | tr -s '[:space:]' ' ' | sed 's/^ //; s/ $//'; }
sleep 1
if declare -F terminal_peek_styled >/dev/null 2>&1; then
  SCREEN_NOW="$(terminal_peek_styled "$BARE_ID" 2>/dev/null)" || exit 23
else
  SCREEN_NOW="$(terminal_peek "$BARE_ID" 2>/dev/null)" || exit 23
fi
if agmsg_input_box_prompt_blocked "$INPUT_REFUSE" "$SCREEN_NOW"; then exit 23; fi
agmsg_input_box_trailing_ok "$INPUT_MAX_TRAILING" "$SCREEN_NOW" || exit 23
REGION_NOW="$(agmsg_input_box_locate "$INPUT_MARKER" "$INPUT_BOXED" "$SCREEN_NOW")" || exit 23
BOX_TEXT="$(agmsg_input_box_draft_text "$INPUT_MARKER" "$INPUT_BOXED" "$REGION_NOW")" || exit 23
[ -n "$(_agy_nudge_norm "$BOX_TEXT")" ] && [ "$(_agy_nudge_norm "$BOX_TEXT")" = "$(_agy_nudge_norm "$TEXT")" ] || exit 23
_herdr_cli "$BARE_ID" pane send-keys "$(_herdr_bare_of "$BARE_ID")" enter >/dev/null 2>&1 || exit 23
exit 0
