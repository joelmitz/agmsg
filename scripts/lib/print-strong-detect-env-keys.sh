#!/usr/bin/env bash
set -euo pipefail
# Unique strong detect= env keys from the type registry. Empty and
# `explicit` are omitted; detect_fallback= is not read. One key per line.
# Invalid tokens are skipped rather than printed.

LIB_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$LIB_DIR/type-registry.sh"

while IFS= read -r _t; do
  [ -n "$_t" ] || continue
  _detect="$(agmsg_type_get "$_t" detect)"
  if [ -z "$_detect" ] || [ "$_detect" = "explicit" ]; then
    continue
  fi
  read -ra _toks <<<"$_detect"
  for _v in "${_toks[@]}"; do
    [ -n "$_v" ] || continue
    case "$_v" in
      [A-Za-z_]* )
        case "${_v#?}" in *[!A-Za-z0-9_]*) continue ;; esac
        ;;
      *) continue ;;
    esac
    printf '%s\n' "$_v"
  done
done < <(agmsg_known_types | sort -u) | LC_ALL=C sort -u
