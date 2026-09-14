#!/usr/bin/env bash
# Which CLI is this? Detection lives here, not in whoami.sh, because whoami.sh
# is not the only caller that needs the answer (#783/#801): windows/dispatch.sh
# hands the type to join.sh, reset.sh, delivery.sh and identities.sh, and a
# default guessed there registers a real agent under a type nobody chose.
#
# Sourcing this requires lib/type-registry.sh first (agmsg_known_types /
# agmsg_type_get). agmsg_detect_cli_type also needs lib/compat.sh
# (compat_get_comm / compat_get_ppid). This file deliberately does not source
# either, so a caller cannot end up with two copies of the registry's state.

# Env-only CLI type from per-type `detect=` keys. Echoes the first match in
# sorted registry order, or nothing if none match. No process-tree walk and no
# `claude-code` fallback — those belong to agmsg_detect_cli_type (bats under
# grok/claude would inherit the parent, and "unknown" must not become claude-code).
# GEMINI_API_KEY can false-positive as gemini (SDK users export it); detect= is not inbox-specific.
agmsg_detect_cli_type_from_env() {
  # `detect=` tokens are split with `read -ra` (IFS word-split, NO pathname
  # expansion) rather than an unquoted `for x in $list` — a file in the caller's
  # cwd matching a pattern like `claude-*` must not glob-eat the pattern. (Plain
  # `set -f` can't be used here: agmsg_known_types discovers types via a `*/`
  # glob that must keep working.)
  #
  # Sorted registry order preserves the historical precedence: a runtime's own
  # session vars (CLAUDE_CODE_SESSION_ID, CODEX_*) are checked before the
  # GEMINI_* family. `detect=explicit` (and types with no detect=) are never
  # auto-detected. A set (non-empty) value counts; the key list is the same as
  # agmsg_detect_cli_type.
  local _t _v _detect _toks
  while IFS= read -r _t; do
    [ -n "$_t" ] || continue
    _detect="$(agmsg_type_get "$_t" detect)"
    if [ -z "$_detect" ] || [ "$_detect" = "explicit" ]; then
      continue
    fi
    read -ra _toks <<<"$_detect"
    for _v in "${_toks[@]}"; do
      if [ -n "${!_v:-}" ]; then
        echo "$_t"
        return 0
      fi
    done
  done <<EOF
$(agmsg_known_types | sort -u)
EOF
}

# Auto-detect CLI type from environment variables and the process tree, driven by
# the per-type manifests' `detect=` (env-var names) and `detect_proc=` (process
# name globs) keys — no hardcoded type list lives here.
agmsg_detect_cli_type() {
  local _from_env
  _from_env="$(agmsg_detect_cli_type_from_env)"
  if [ -n "$_from_env" ]; then
    echo "$_from_env"
    return 0
  fi

  # Process-tree detection via each type's `detect_proc=` name globs. Walk up
  # from this process; at each ancestor the first type whose glob matches wins
  # (the globs are disjoint, so order within a level is irrelevant).
  local pid=$$ max_depth=10 depth=0 proc_name _pats _pat _t _toks
  while [ $depth -lt $max_depth ] && [ "$pid" != "1" ] && [ -n "$pid" ]; do
    proc_name=$(compat_get_comm "$pid" 2>/dev/null || true)
    if [ -n "$proc_name" ]; then
      while IFS= read -r _t; do
        [ -n "$_t" ] || continue
        _pats="$(agmsg_type_get "$_t" detect_proc)"
        [ -n "$_pats" ] || continue
        read -ra _toks <<<"$_pats"
        for _pat in "${_toks[@]}"; do
          # $_pat is intentionally an UNQUOTED glob pattern matched against the
          # process name; read -ra already kept it out of pathname expansion.
          # shellcheck disable=SC2254
          case "$proc_name" in
            $_pat) echo "$_t"; return 0 ;;
          esac
        done
      done <<EOF
$(agmsg_known_types | sort -u)
EOF
    fi

    # Move to parent process
    pid=$(compat_get_ppid "$pid" 2>/dev/null || true)
    depth=$((depth + 1))
  done

  # Default fallback. A LITERAL, and the one name here that no registry lookup
  # stands behind — which is why whoami.sh validates only a type the caller
  # asked for, and why nothing may treat this function's output as a member of
  # agmsg_known_types.
  echo "claude-code"
}
