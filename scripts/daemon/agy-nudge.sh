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
# 22 the seat is not an antigravity seat, 23 (live only, herdr) the line was typed but
# its submission could not be confirmed; one reason word is printed first
# (NUDGE-REASON:<word>, see the herdr block at the end). After typing, NUDGE-TYPED is printed
# so the caller knows typing happened even if this script is later stopped. Each delivery check
# prints NUDGE-CHECK:<n> (n = 1..3) when it starts, so the daemon can tell how far a run got.
set -euo pipefail

# Stage timing for the daemon's nudge_run record. Origin: this statement, so the time Git Bash itself needed to
# start before it is NOT included (the daemon's own clock sees that part, see antigravity-nudge.mjs). The clock is
# the wall clock: $EPOCHREALTIME when bash has it (no process is started), else `date +%s%3N` (one external
# process per reading, a cost not yet measured). A wall clock can be stepped by a time correction. Marks go to fd 7
# (a copy of stdout kept from here on), never to stdout inside a command substitution, and carry only a fixed stage
# name and a number: no notice text, path, token or nonce.
_AGY_T0=""
_AGY_NOW=""
_agy_now_ms() {
  local us v
  if [ -n "${EPOCHREALTIME:-}" ]; then
    us="${EPOCHREALTIME//[.,]/}"
    case "$us" in ''|*[!0-9]*) return 1 ;; esac
    _AGY_NOW=$((10#$us / 1000)); return 0
  fi
  v="$(date +%s%3N 2>/dev/null)" || return 1
  case "$v" in ''|*[!0-9]*) return 1 ;; esac
  _AGY_NOW=$v
}
{ exec 7>&1; } 2>/dev/null || true
_agy_now_ms && _AGY_T0=$_AGY_NOW || true
_agy_mark() {   # <fixed stage name>
  [ -n "$_AGY_T0" ] || return 0
  _agy_now_ms || return 0
  printf 'NUDGE-STAGE:%s:%s\n' "$1" "$((_AGY_NOW - _AGY_T0))" >&7 2>/dev/null || true
}

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
_agy_mark libs

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

_agy_mark resolved

# Observe safe-poke's reads and the poke WITHOUT changing the shared safe-poke.sh: it looks these functions up by
# name at call time, so each is wrapped here. A wrapper calls the original with the same arguments and returns its
# exit status and stdout untouched (stdout is a command substitution's value); the mark goes to fd 7. Every
# terminal_peek* call is marked "peek" (in order: safe-poke's two reads, then the delivery checks), the poke "poked".
# A refusal before the second read (a draft, a confirmation screen, an unclear structure) simply has fewer marks.
_agy_wrap() {   # <function name> <stage name>
  declare -F "$1" >/dev/null 2>&1 || return 0
  eval "_agy_orig_$(declare -f "$1")"
  eval "$1() { local _rc=0; _agy_orig_$1 \"\$@\" || _rc=\$?; _agy_mark $2; return \"\$_rc\"; }"
}
_agy_wrap terminal_peek_styled peek
_agy_wrap terminal_peek peek
_agy_wrap terminal_poke poked

RC=0
agmsg_safe_poke "$BARE_ID" "$TEXT" "$INPUT_MARKER" "$INPUT_BOXED" "$TEAM" "$NAME" \
  --retries 0 --refuse-screen "$INPUT_REFUSE" --max-trailing "$INPUT_MAX_TRAILING" >/dev/null 2>&1 || RC=$?
[ "$RC" -eq 0 ] || exit "$RC"
# A dry run ends here: it typed nothing and sends no Enter.
[ "$MODE" = live ] || exit 0
echo NUDGE-TYPED

# herdr only. What happens after typing depends on the terminal driver's own poke:
#  - tmux (and any driver that submits inside terminal_poke): nothing more to do here.
#  - herdr: `agent prompt` submits by itself for agy (measured on Windows with herdr 0.9.3: the
#    line was already in the conversation and answered, no Enter needed), so by default
#    (AGMSG_AGY_NUDGE_ENTER=auto, herdr on Windows) NO Enter is sent. Instead the delivery is
#    VERIFIED: the line's token shows in the CONVERSATION (on screen, outside the located input
#    box; the agent merely being busy is not evidence). always = herdr on any OS, and in addition sends ONE Enter if
#    the input box holds exactly this line AND no confirmation screen shows AND the structure is sane; off = no check at all.
# Not confirmed -> exit 23 with one reason word on stdout (NUDGE-REASON:<word>), never a path
# or text: box_has_line (still unsubmitted in the box), box_empty (nothing to see), box_mismatch
# (another draft there), confirmation_screen, box_unlocated, peek_failed, enter_send_failed.
WANT_CHECK=0
SEND_ENTER=0
case "${AGMSG_AGY_NUDGE_ENTER:-auto}" in
  off) exit 0 ;;
  always) WANT_CHECK=1; SEND_ENTER=1 ;;
  *) case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) WANT_CHECK=1 ;; esac ;;
esac
[ "$WANT_CHECK" -eq 1 ] && [ "$TERMINAL" = herdr ] || exit 0
_agy_reason() { echo "NUDGE-REASON:$1"; exit 23; }
declare -F _herdr_cli >/dev/null 2>&1 && declare -F _herdr_bare_of >/dev/null 2>&1 || _agy_reason peek_failed

_agy_nudge_norm() { printf '%s' "$1" | tr -s '[:space:]' ' ' | sed 's/^ //; s/ $//'; }
TOKEN="${TEXT%%]*}]"
ENTER_SENT=0
REASON=box_empty
for ATTEMPT in 1 2 3; do
  # Stage marker for the daemon's timing record: only the attempt number, no text.
  echo "NUDGE-CHECK:$ATTEMPT"
  sleep 1
  if declare -F terminal_peek_styled >/dev/null 2>&1; then
    SCREEN_NOW="$(terminal_peek_styled "$BARE_ID" 2>/dev/null)" || _agy_reason peek_failed
  else
    SCREEN_NOW="$(terminal_peek "$BARE_ID" 2>/dev/null)" || _agy_reason peek_failed
  fi
  BOX_TEXT=""; LOCATED=0; REGION_NOW=""
  if REGION_NOW="$(agmsg_input_box_locate "$INPUT_MARKER" "$INPUT_BOXED" "$SCREEN_NOW")"; then
    LOCATED=1
    BOX_TEXT="$(agmsg_input_box_draft_text "$INPUT_MARKER" "$INPUT_BOXED" "$REGION_NOW")" || BOX_TEXT=""
  fi
  NORM_BOX="$(_agy_nudge_norm "$BOX_TEXT")"
  BLOCKED=0; agmsg_input_box_prompt_blocked "$INPUT_REFUSE" "$SCREEN_NOW" && BLOCKED=1
  TRAIL_OK=1; agmsg_input_box_trailing_ok "$INPUT_MAX_TRAILING" "$SCREEN_NOW" || TRAIL_OK=0
  if [ "$LOCATED" -eq 1 ] && [ -n "$NORM_BOX" ] && [ "$NORM_BOX" = "$(_agy_nudge_norm "$TEXT")" ]; then
    # The line is sitting in the box: not submitted (yet). A NEW key is sent only when the screen is a
    # live input box: no confirmation screen, a sane structure, and the box holds exactly this line.
    if [ "$SEND_ENTER" -eq 1 ] && [ "$ENTER_SENT" -eq 0 ] && [ "$BLOCKED" -eq 0 ] && [ "$TRAIL_OK" -eq 1 ]; then
      ENTER_SENT=1
      _herdr_cli "$BARE_ID" pane send-keys "$(_herdr_bare_of "$BARE_ID")" enter >/dev/null 2>&1 || _agy_reason enter_send_failed
    fi
    if [ "$BLOCKED" -eq 1 ]; then REASON=confirmation_screen; elif [ "$TRAIL_OK" -eq 0 ]; then REASON=box_unlocated; else REASON=box_has_line; fi
    continue
  fi
  # Submitted = the token is in the CONVERSATION: on screen outside the input box that was located. Only
  # with a located box can the two be told apart, so without one nothing is concluded from the token. This
  # is an observation, not a key press, so it still holds when a confirmation screen has appeared since.
  if [ "$LOCATED" -eq 1 ]; then
    CONV=""
    while IFS= read -r LINE; do
      SKIP=0
      while IFS= read -r RLINE; do [ "$LINE" = "$RLINE" ] && { SKIP=1; break; }; done <<<"$REGION_NOW"
      [ "$SKIP" -eq 1 ] || CONV="$CONV$LINE"$'\n'
    done <<<"$SCREEN_NOW"
    if printf '%s' "$CONV" | grep -qF -- "$TOKEN"; then exit 0; fi
  fi
  if [ "$BLOCKED" -eq 1 ]; then REASON=confirmation_screen
  elif [ "$LOCATED" -eq 0 ]; then REASON=box_unlocated
  elif [ -n "$NORM_BOX" ]; then REASON=box_mismatch
  else REASON=box_empty; fi
done
_agy_reason "$REASON"
