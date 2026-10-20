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

# Legacy role records predate codex_home=. They belong to the default
# $HOME/.codex state root, never to an opt-in isolated home.
agmsg_codex_role_home_matches() {
  local recorded="$1" current default
  current="$(agmsg_codex_effective_home)"
  [ -n "$current" ] || return 1
  if [ -z "$recorded" ]; then
    default="$(agmsg_codex_default_home)"
    [ -n "$default" ] || return 1
    recorded="$default"
  fi
  [ "${recorded%/}" = "${current%/}" ]
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
