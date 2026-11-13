#!/usr/bin/env bash
# agy PreToolUse hook: deny a run_command that tries to run inbox.sh / check-inbox.sh while a TUI monitor owns the seat.
#
# Needs only bash and standard commands (awk, tr, iconv, printf); no python3 / jq / node. Same on Windows Git Bash.
# Without iconv or tr the input cannot be inspected, so it fails closed and denies everything
# (if every run_command is refused on some other machine, first check that iconv and tr are on PATH).
# Why: agy starts hooks through cmd.exe. On a Japanese-locale Windows without python3, cmd's error text (CP932)
# goes to stderr, agy cannot read it as UTF-8, and the executor fails (observed on a real Windows machine,
# 2026-10-30). So this script writes nothing to stderr, even on failure paths.
#
# Deny rule (two stages): first, if CommandLine (the decoded JSON value) contains inbox.sh or check-inbox.sh and the
# characters before and after it are not filename characters (alphanumerics, _, ., -), it is a "match"; otherwise allow.
# If the JSON cannot be parsed, or contains NUL or invalid UTF-8, deny (whether or not it would match), because it
# cannot be inspected safely. Only on a match, look for a supervisor reservation trace in agmsg's run/ (any agy
# reservation on this machine; it is not narrowed to one seat):
#   trace present   -> deny (a monitor manages receipt; if agy reads the inbox it breaks the supervisor)
#   no trace        -> allow (no monitor manages receipt; agy reads it itself under nudge / turn)
#   run/ unreadable -> deny (fail closed; cannot tell whether a trace exists)
# A trace is any read-reservation.*.json, or a legacy antigravity-reservation.*.json, directly under run/. Its mere
# existence is enough (content, type and whether the pid is alive are not checked; a stale one still counts; same idea
# as the reservationTrace exclusion gate of agmsgd's nudge channel). Side files such as .violations do not count.
# Where run/ is: $AGMSG_SKILL_DIR/run if AGMSG_SKILL_DIR is set; else <skill dir>/run derived from this script's
# location; else $HOME/.agents/skills/agmsg/run (agmsg's default install location, also on Windows Git Bash).
# The former (Python) condition was "preceded by whitespace, / or start, followed by whitespace, ;|&<> or end". This
# condition is a superset of it (anything the old one denied is still denied). It avoids enumerating whitespace kinds
# (including Unicode whitespace) and quoting or bracketing individually; the cost is that a command with a non-ASCII
# character (e.g. Japanese) directly before or after inbox.sh is also denied (judged harmless). Unrelated commands
# such as history.sh are unaffected.
# Output is {"decision": ..., "reason": ...}.
exec 2>/dev/null
set -u

# Be self-contained when started with a PATH that lacks the tools below. On Windows, agy starts this through an
# absolute path to Git's bash.exe from a PATH that may have no Git directory at all; a non-login msys bash does not
# add /usr/bin itself, so tr / iconv / awk would not resolve and every command would be denied (fail closed).
# Append (never prepend) the directory of the running bash and the usual system directories, so a PATH that
# already resolves them behaves exactly as before. If the tools are truly missing, the fail-closed deny remains.
PATH="${PATH:-}:${BASH:+${BASH%/*}:}/usr/bin:/bin"

# NUL is replaced with SOH (\001) before reading, because a shell variable cannot hold NUL and would silently drop it.
# \001 is an invalid control character in JSON, so the later inspection always denies it. Input that is invalid
# UTF-8 is also denied (the former Python version could not read it as text, raised, and so denied).
payload=$(LC_ALL=C tr '\000' '\001') || payload=""
valid_input=0
if command -v iconv >/dev/null 2>&1 && printf '%s' "$payload" | iconv -f UTF-8 -t UTF-8 >/dev/null 2>&1; then
  valid_input=1
fi

verdict=invalid
if [ "$valid_input" = 1 ]; then
verdict=$(printf '%s' "$payload" | LC_ALL=C awk '
BEGIN { ORS = ""; HEX = "0123456789abcdef" }
# Input lines are buffered and inspected in END (RS is not used as a separator, so no part of the input is dropped)
{ buf = (NR == 1) ? $0 : buf "\n" $0 }
function fail() { bad = 1 }
# Read a JSON string starting at position i (the opening quote). Returns the decoded value in str and the next position in pos.
function readstr(    c, e, h, k, code, out) {
  out = ""
  i++
  while (i <= n) {
    c = substr(s, i, 1)
    if (c == "\"") { i++; str = out; return 1 }
    if (c ~ /[\001-\037]/) { return 0 }
    if (c == "\\") {
      e = substr(s, i + 1, 1)
      if (e == "\"" || e == "\\" || e == "/") { out = out e; i += 2; continue }
      if (e == "n") { out = out "\n"; i += 2; continue }
      if (e == "t") { out = out "\t"; i += 2; continue }
      if (e == "r") { out = out "\r"; i += 2; continue }
      if (e == "b" || e == "f") { out = out " "; i += 2; continue }
      if (e == "u") {
        code = 0
        for (k = 1; k <= 4; k++) {
          h = index(HEX, tolower(substr(s, i + 1 + k, 1)))
          if (h == 0 || substr(s, i + 1 + k, 1) == "") { return 0 }
          code = code * 16 + (h - 1)
        }
        if (code == 0) { out = out " " }
        else if (code < 128) { out = out sprintf("%c", code) }
        else { out = out "?" }
        i += 6
        continue
      }
      return 0
    }
    out = out c
    i++
  }
  return 0
}
function afterValue() {
  if (depth == 0) { expect = "DONE" } else { expect = "COMMA_OR_END" }
}
END {
  s = buf; n = length(s); i = 1; depth = 0; expect = "VALUE"; bad = 0; seen = 0
  nvals = 0; lastkey = ""; keyed = 0
  top = ""
  if (s !~ /^[ \t\r\n]*\{/) { bad = 1 }
  while (!bad && i <= n) {
    c = substr(s, i, 1)
    if (c == " " || c == "\t" || c == "\n" || c == "\r") { i++; continue }
    if (expect == "DONE") { bad = 1; break }
    if (expect == "VALUE" || expect == "VALUE_OR_END") {
      if (c == "{") { depth++; stack[depth] = "{"; expect = "KEY_OR_END"; i++; keyed = 0 }
      else if (c == "[") { depth++; stack[depth] = "["; expect = "VALUE_OR_END"; i++; keyed = 0 }
      else if (c == "]" && expect == "VALUE_OR_END") { depth--; i++; afterValue(); keyed = 0 }
      else if (c == "\"") {
        if (!readstr()) { bad = 1; break }
        if (keyed && (lastkey == "CommandLine" || lastkey == "commandLine")) { vals[++nvals] = str }
        keyed = 0
        afterValue()
      } else {
        rest = substr(s, i, 40)
        if (match(rest, /^(true|false|null|-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?)/)) { i += RLENGTH; keyed = 0; afterValue() }
        else { bad = 1; break }
      }
    } else if (expect == "KEY_OR_END" || expect == "KEY") {
      if (c == "}" && expect == "KEY_OR_END") { depth--; i++; afterValue(); keyed = 0 }
      else if (c == "\"") {
        if (!readstr()) { bad = 1; break }
        lastkey = str; expect = "COLON"
      } else { bad = 1; break }
    } else if (expect == "COLON") {
      if (c == ":") { expect = "VALUE"; keyed = 1; i++ } else { bad = 1; break }
    } else if (expect == "COMMA_OR_END") {
      if (c == ",") { i++; if (stack[depth] == "{") { expect = "KEY" } else { expect = "VALUE" }; keyed = 0 }
      else if (c == "}" && stack[depth] == "{") { depth--; i++; afterValue(); keyed = 0 }
      else if (c == "]" && stack[depth] == "[") { depth--; i++; afterValue(); keyed = 0 }
      else { bad = 1; break }
    }
  }
  if (bad || expect != "DONE" || depth != 0) { print "invalid" }
  else {
  deny = 0
  for (k = 1; k <= nvals; k++) {
    if (vals[k] ~ /(^|[^A-Za-z0-9_.-])(check-)?inbox\.sh($|[^A-Za-z0-9_.-])/) { deny = 1 }
  }
  print (deny ? "match" : "allow")
  }
}
') || verdict=invalid
fi

# In the version agmsg ships (delivery.sh set monitor registers it in hooks.json by absolute path), this script
# lives in <skill dir>/scripts/drivers/types/antigravity/hooks/. It derives <skill dir> from its own location
# and does not depend on cwd or HOME (AGMSG_SKILL_DIR takes precedence if set).
self_skill_dir=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../../../../.." 2>/dev/null && pwd) || self_skill_dir=""

# Only on a match, look for a reservation trace (see the header comment for how run/ is resolved)
trace_state() {
  local base run f
  base=${AGMSG_SKILL_DIR:-}
  if [ -z "$base" ] && [ -d "$self_skill_dir/run" ]; then
    base=$self_skill_dir
  fi
  if [ -z "$base" ]; then
    [ -n "${HOME:-}" ] || { printf unknown; return; }
    base=$HOME/.agents/skills/agmsg
  fi
  run=$base/run
  if [ ! -d "$run" ] || [ ! -r "$run" ] || [ ! -x "$run" ]; then printf unknown; return; fi
  for f in "$run"/read-reservation.*.json "$run"/antigravity-reservation.*.json; do
    if [ -e "$f" ] || [ -L "$f" ]; then printf trace; return; fi
  done
  printf none
}
if [ "$verdict" = match ]; then
  case "$(trace_state)" in
    none) verdict=allow ;;
    trace) verdict=deny ;;
    *) verdict=unreadable ;;
  esac
fi

case "$verdict" in
  allow)
    printf '%s\n' '{"decision": "allow"}'
    ;;
  deny)
    printf '%s\n' '{"decision": "deny", "reason": "The Antigravity TUI bridge manages receipt, so inbox.sh/check-inbox.sh cannot be run. Use history.sh to review history."}'
    ;;
  unreadable)
    printf '%s\n' '{"decision": "deny", "reason": "agmsg cannot confirm whether a read reservation exists, so inbox.sh/check-inbox.sh cannot be run. Use history.sh to review history."}'
    ;;
  *)
    printf '%s\n' '{"decision": "deny", "reason": "agmsg inbox guard could not inspect the command safely"}'
    ;;
esac
