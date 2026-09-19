#!/usr/bin/env bash
set -euo pipefail

# Run the Bats program itself through POSIX bash. On Git Bash, `bats` may be
# the npm shim, whose wrapper can leave the test in a Windows/POSIX path and
# process-space mismatch. Prefer the installed Bats entrypoint under the npm
# prefix and never silently fall back to that shim.

if [ -n "${AGMSG_BATS_BIN:-}" ]; then
  bats_bin="$AGMSG_BATS_BIN"
else
  bats_bin=""
  case "$(uname -s 2>/dev/null || true)" in
    MINGW*|MSYS*|CYGWIN*)
      for candidate in \
        "${HOME:-}/AppData/Roaming/npm/node_modules/bats/bin/bats" \
        /c/Users/joel/AppData/Roaming/npm/node_modules/bats/bin/bats \
        /usr/local/lib/node_modules/bats/bin/bats; do
        if [ -f "$candidate" ]; then bats_bin="$candidate"; break; fi
      done
      ;;
    *)
      bats_bin="$(command -v bats 2>/dev/null || true)"
      ;;
  esac
fi

[ -f "$bats_bin" ] || {
  printf 'test-bats-posix: Bats entrypoint not found: %s\n' "$bats_bin" >&2
  exit 127
}

if [ -x /usr/bin/bash ]; then
  exec /usr/bin/bash "$bats_bin" "$@"
fi
exec bash "$bats_bin" "$@"
