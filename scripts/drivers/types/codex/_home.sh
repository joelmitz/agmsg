#!/usr/bin/env bash
# Codex state-root helpers shared by the monitor, hooks, and bridge launcher.

agmsg_codex_effective_home() {
  if [ -n "${AGMSG_CODEX_HOME:-}" ]; then
    printf '%s' "$AGMSG_CODEX_HOME"
  elif [ -n "${CODEX_HOME:-}" ]; then
    printf '%s' "$CODEX_HOME"
  elif [ -n "${ORCA_CODEX_HOME:-}" ]; then
    # Integration hint for an Orca-managed account home. The variable name is
    # not part of the public Orca CLI contract; verify it in the managed pane.
    # Keep explicit agmsg/Codex overrides ahead of this unverified hint.
    printf '%s' "$ORCA_CODEX_HOME"
  elif [ -n "${HOME:-}" ]; then
    printf '%s/.codex' "$HOME"
  fi
}

agmsg_codex_default_home() {
  [ -n "${HOME:-}" ] && printf '%s/.codex' "$HOME"
}

# The canonical spelling of a Codex profile directory, by the SAME rules the
# writers use (_profile.sh's agmsg_codex_profile_canonical, which records
# codex_home=): an existing absolute directory, resolved to its physical path
# (symlinks followed) and normalized (Git Bash /c/... and native C:\... both
# become C:/...). Prints nothing and returns 1 when it cannot be resolved.
# Duplicated rather than shared: _home.sh and _profile.sh must not source each
# other (the sourcing graph stays acyclic).
_agmsg_codex_home_canonical() {
  local home="${1:-}"
  case "$home" in
    *[[:cntrl:]]*|'') return 1 ;;
    /* | [A-Za-z]:/* | [A-Za-z]:\\*) ;;
    *) return 1 ;;
  esac
  [ -d "$home" ] || return 1
  if ! declare -F agmsg_canonical_path >/dev/null 2>&1 \
     || ! declare -F agmsg_normalize_project_path >/dev/null 2>&1; then
    [ -n "${SKILL_DIR:-}" ] || return 1
    # shellcheck source=../../../lib/resolve-project.sh
    . "$SKILL_DIR/scripts/lib/resolve-project.sh" || return 1
  fi
  home="$(agmsg_canonical_path "$home")" || return 1
  home="$(agmsg_normalize_project_path "$home")" || return 1
  case "$home" in
    *[[:cntrl:]]*|'') return 1 ;;
    /* | [A-Za-z]:/* | [A-Za-z]:\\*) ;;
    *) return 1 ;;
  esac
  printf '%s\n' "$home"
}

# rc 0 when <recorded> (a role record's codex_home=) names the same profile
# directory this process runs in. Both sides are compared in the writers'
# canonical form, so a symlinked CODEX_HOME or a Git Bash /c/... spelling of
# the recorded C:/... directory still matches, while a different directory
# never does. An identical spelling (trailing / aside) matches as before;
# otherwise either side that cannot be resolved is a mismatch (fail closed).
# Legacy role records predate codex_home=. They belong to the default
# $HOME/.codex state root, never to an opt-in isolated home.
agmsg_codex_role_home_matches() {
  local recorded="$1" current
  current="$(agmsg_codex_effective_home)"
  [ -n "$current" ] || return 1
  if [ -z "$recorded" ]; then
    recorded="$(agmsg_codex_default_home)"
    [ -n "$recorded" ] || return 1
  fi
  # The same spelling is the same directory, whether or not it exists yet.
  [ "${recorded%/}" = "${current%/}" ] && return 0
  current="$(_agmsg_codex_home_canonical "$current")" || return 1
  recorded="$(_agmsg_codex_home_canonical "$recorded")" || return 1
  [ "$recorded" = "$current" ]
}

agmsg_codex_sessions_dir() {
  local root
  root="$(agmsg_codex_effective_home)"
  [ -n "$root" ] && printf '%s/sessions' "${root%/}"
}

# Validate the opt-in AGMSG_CODEX_HOME and export the resolved Codex state root
# as CODEX_HOME, so every launch path -- the monitor and the agmsgd plain-launch
# path in the shim -- starts Codex in the same profile the recorder reports.
# <label> prefixes error messages. Returns 1 (after printing why) when the
# value is unusable; callers must not start Codex in that case.
agmsg_codex_apply_home() {
  local label="${1:-codex}" resolved
  if [ -n "${AGMSG_CODEX_HOME:-}" ]; then
    case "$AGMSG_CODEX_HOME" in
      /*) ;;
      *) echo "$label: AGMSG_CODEX_HOME must be an absolute path" >&2; return 1 ;;
    esac
    case "$AGMSG_CODEX_HOME" in
      *$'\n'*|*$'\r'*) echo "$label: AGMSG_CODEX_HOME must not contain newlines" >&2; return 1 ;;
    esac
    [ "$AGMSG_CODEX_HOME" != "/" ] || { echo "$label: AGMSG_CODEX_HOME must not be /" >&2; return 1; }
    # Every step is checked explicitly: callers invoke this as `... || exit 1`,
    # which disables errexit inside the function, so nothing here may rely on
    # set -e to stop a failed step.
    if [ ! -e "$AGMSG_CODEX_HOME" ]; then
      if ! (umask 077 && mkdir -p "$AGMSG_CODEX_HOME"); then
        echo "$label: cannot create AGMSG_CODEX_HOME" >&2
        return 1
      fi
    fi
    [ -d "$AGMSG_CODEX_HOME" ] || { echo "$label: AGMSG_CODEX_HOME is not a directory" >&2; return 1; }
    # Normalize into a local first; AGMSG_CODEX_HOME is only replaced once the
    # directory is known to be enterable, so a failure never empties it and
    # silently falls back to an inherited CODEX_HOME or the default profile.
    local normalized
    if ! normalized="$(cd "$AGMSG_CODEX_HOME" && pwd)" || [ -z "$normalized" ]; then
      echo "$label: AGMSG_CODEX_HOME is not accessible" >&2
      return 1
    fi
    [ "$normalized" != "/" ] || { echo "$label: AGMSG_CODEX_HOME must not be /" >&2; return 1; }
    AGMSG_CODEX_HOME="$normalized"
    export AGMSG_CODEX_HOME
  fi
  resolved="$(agmsg_codex_effective_home)"
  [ -n "$resolved" ] || { echo "$label: cannot resolve CODEX_HOME" >&2; return 1; }
  CODEX_HOME="$resolved"
  export CODEX_HOME
}
