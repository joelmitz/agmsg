#!/usr/bin/env bash
# agy inbox-guard hook registration (<project>/.agents/hooks.json).
#
# While an Antigravity TUI monitor owns a seat, a plain inbox.sh / check-inbox.sh
# run by agy itself would mark messages read behind the supervisor's back. agy
# lets a PreToolUse hook deny a run_command, so `delivery.sh set monitor` registers
# hooks/block-agmsg-inbox.sh there, and any other mode removes it again.
#
# agy's hooks.json is NOT the Claude/Codex `.hooks.<event>` shape: the top-level
# keys are hook-set names, each holding an event map. agmsg owns exactly one
# top-level key (AGMSG_AGY_GUARD_KEY); every other key keeps its name and value.
# The file is rewritten through sqlite's json functions, so whitespace and layout
# of the OTHER keys can change (the same as the existing .hooks.<event> editing);
# only the indent unit of a pretty-printed file is carried over (see
# _agmsg_hooks_file_finish_write). A file whose content would not change is not
# rewritten at all (#1429).
#
# Sourced by _delivery.sh, inside delivery.sh's context (SKILL_DIR,
# agmsg_sqlite_mem and _agmsg_hooks_file_finish_write are already defined).

AGMSG_AGY_GUARD_KEY="agmsg-tui-inbox-guard"

_agmsg_agy_guard_script() {
  printf '%s' "$SKILL_DIR/scripts/drivers/types/antigravity/hooks/block-agmsg-inbox.sh"
}

# 0 when the hook will be run by a native-Windows agy (Git Bash host). The
# override exists so tests can exercise the Windows command on Linux.
_agmsg_agy_guard_is_windows() {
  case "${AGMSG_AGY_GUARD_PLATFORM:-$(uname -s 2>/dev/null)}" in
    windows|MINGW*|MSYS*|CYGWIN*) return 0 ;;
  esac
  return 1
}

# The command agy runs. POSIX: `bash '<script>'`. Windows: agy runs hooks through
# cmd.exe/PowerShell, where a bare `bash` is not on PATH by default (that made
# every run_command fail, 2026-11-13), so name Git Bash by absolute path. The
# file is written by the agmsg that is running in that same Git Bash, so ask it
# which bash it is ($GIT_BASH / $AGMSG_BASH win, as in the codex wrapper; then the
# running bash via cygpath's 8.3 short path; then Git for Windows' default path).
# The executable path must contain no space: that is the only form that parses the
# same in cmd.exe and PowerShell (PowerShell cannot start a quoted executable
# without `&`, which cmd.exe cannot parse). With a space (8.3 names disabled, or a
# $GIT_BASH/$AGMSG_BASH given with one) there is no command that works in both, so
# this FAILS (returns 1) and the caller registers nothing: an unregistered guard is
# safer than a hook that errors and stops every run_command. The script path is an
# argument, so quoting it is fine in both shells.
_agmsg_agy_guard_command() {
  local script; script="$(_agmsg_agy_guard_script)"
  if ! _agmsg_agy_guard_is_windows; then
    printf '%s' "bash $(_agmsg_shq "$script")"
    return 0
  fi
  local bash_exe="${GIT_BASH:-${AGMSG_BASH:-}}" win_script="$script"
  if [ -z "$bash_exe" ] && command -v cygpath >/dev/null 2>&1; then
    bash_exe="$(cygpath -ws "$(command -v bash)" 2>/dev/null || true)"
  fi
  [ -n "$bash_exe" ] || bash_exe='C:\Program Files\Git\bin\bash.exe'
  case "$bash_exe" in
    *\ *)
      echo "agmsg: the Git Bash path has a space ($bash_exe) and no 8.3 short name is available; set GIT_BASH to a path without spaces (e.g. C:\\PROGRA~1\\Git\\bin\\bash.exe)" >&2
      return 1 ;;
  esac
  if command -v cygpath >/dev/null 2>&1; then
    win_script="$(cygpath -m "$script" 2>/dev/null || printf '%s' "$script")"
  fi
  case "$win_script" in *\ *) win_script="\"$win_script\"" ;; esac
  printf '%s' "$bash_exe $win_script"
}

# Rewrites <project>/.agents/hooks.json: removes our key and, when $1 = install,
# adds it back with the current command. Goes through _agmsg_hooks_file_finish_write
# so an unchanged file is not touched (#1429).
_agmsg_agy_guard_apply() {
  local action="$1" project="$2" file="$2/.agents/hooks.json"
  if [ "$action" = remove ]; then
    [ -f "$file" ] || return 0
  else
    mkdir -p "$(dirname "$file")" || return 1
  fi
  local tmp tmp_sql sql_in wrote
  tmp=$(mktemp "${TMPDIR:-/tmp}/agmsg.XXXXXX")
  tmp_sql=$(agmsg_sql_readfile_path "$tmp")
  if [ -f "$file" ]; then cp "$file" "$tmp"; else printf '{}' > "$tmp"; fi
  sql_in=$(agmsg_sql_readfile_path "$tmp")
  local key_lit; key_lit="$AGMSG_AGY_GUARD_KEY"
  local set_expr="json_remove(j, '\$.\"$key_lit\"')"
  if [ "$action" = install ]; then
    local cmd_lit
    cmd_lit=$(_agmsg_agy_guard_command) || return 1
    cmd_lit=$(printf '%s' "$cmd_lit" | LC_ALL=C sed "s/'/''/g")
    set_expr="json_set($set_expr, '\$.\"$key_lit\"', json_object('PreToolUse', json_array(json_object(
      'matcher','run_command','hooks', json_array(json_object('type','command','command','$cmd_lit','timeout',5))))))"
  fi
  # A hooks.json that is not a JSON object is left alone (json_type guard).
  local tmp2 tmp2_sql
  tmp2=$(mktemp "${TMPDIR:-/tmp}/agmsg.XXXXXX")
  tmp2_sql=$(agmsg_sql_readfile_path "$tmp2")
  wrote=$(agmsg_sqlite_mem "
    WITH src AS (SELECT readfile('$sql_in') AS j),
    out AS (SELECT CASE WHEN json_valid(j) AND json_type(j) = 'object' THEN $set_expr END AS blob FROM src)
    SELECT writefile('$tmp2_sql', blob) = length(CAST(blob AS BLOB)) FROM out WHERE blob IS NOT NULL;
  " 2>/dev/null) || wrote=""
  rm -f "$tmp"
  if [ "$wrote" != 1 ]; then
    rm -f "$tmp2"
    echo "agmsg: $file is not a JSON object; left unchanged (inbox guard hook NOT updated)" >&2
    return 1
  fi
  # Removing the last key of a file agmsg created leaves '{}': drop the file.
  if [ "$action" = remove ] && [ "$(tr -d ' \t\r\n' < "$tmp2")" = '{}' ]; then
    rm -f "$tmp2" "$file"
    return 0
  fi
  _agmsg_hooks_file_finish_write "$file" "$tmp2" monitor antigravity "$project"
}

# Installed for monitor mode only (the guard protects a monitor-owned seat; in
# turn/off modes agy must run check-inbox.sh itself). A failure is reported but
# never fails delivery: an unguarded seat is better than no delivery setup.
agmsg_agy_guard_sync() {
  local mode="$1" project="$2" action=remove
  [ "$mode" = monitor ] && action=install
  _agmsg_agy_guard_apply "$action" "$project" || {
    echo "agmsg: warning: could not $action the agy inbox guard hook in $project/.agents/hooks.json" >&2
    # A failed install must not leave an older (possibly broken) entry behind.
    if [ "$action" = install ]; then _agmsg_agy_guard_apply remove "$project" 2>/dev/null || true; fi
    return 0
  }
}
