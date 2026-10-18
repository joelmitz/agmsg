#!/usr/bin/env bats
# Fork: test_helper.bash's own isolation from a developer shell -- the host
# `orca` mirror and the Codex profile vars. Every case runs against a fake
# host bin dir; the real host orca is never executed (the fake one fails
# loudly if anything runs it).

load test_helper

HELPER="$BATS_TEST_DIRNAME/test_helper.bash"

setup() {
  FAKE_HOST="$BATS_TEST_TMPDIR/host-bin"
  RUN_DIR="$BATS_TEST_TMPDIR/run"
  mkdir -p "$FAKE_HOST" "$RUN_DIR"
  printf '#!/bin/sh\necho FAKE-HOST-ORCA-WAS-RUN >&2\nexit 99\n' > "$FAKE_HOST/orca"
  printf '#!/bin/sh\necho sentinel\n' > "$FAKE_HOST/agmsg-sentinel"
  chmod +x "$FAKE_HOST/orca" "$FAKE_HOST/agmsg-sentinel"
  MIRROR_ROOT="$RUN_DIR/agmsg-path-no-orca"
}

teardown() {
  if [ -n "${TEST_SKILL_DIR:-}" ]; then teardown_test_env; fi
}

# Source the helper in a fresh bash whose PATH starts with the fake host dir.
# $1 is a prelude run before the source (e.g. a failing `ln`).
_probe() {
  HELPER="$HELPER" BATS_RUN_TMPDIR="$RUN_DIR" PATH="$FAKE_HOST:$PATH" bash -c "$1"'
    source "$HELPER"; echo "load_rc=$?"
    command -v orca || echo "orca=missing"
    command -v agmsg-sentinel || echo "sentinel=missing"
    if command -v bash >/dev/null; then echo "bash=ok"; else echo "bash=missing"; fi
  '
}

@test "host orca: hidden behind a mirror that keeps every other command" {
  run _probe ''
  [ "$status" -eq 0 ] || return 1
  grep -qx 'load_rc=0' <<<"$output" || return 1
  grep -qx 'orca=missing' <<<"$output" || return 1
  grep -qx "$MIRROR_ROOT/.*/agmsg-sentinel" <<<"$output" || return 1
  grep -qx 'bash=ok' <<<"$output"
}

@test "host orca: a mirror that cannot be published fails the load, PATH is not left broken" {
  # Every publish attempt is refused (as a non-GNU or failing ln would).
  run _probe 'ln() { if [ "$1" = -sn ]; then return 1; fi; command ln "$@"; }
'
  [ "$status" -eq 0 ] || return 1
  grep -qx 'load_rc=1' <<<"$output" || return 1
  grep -q 'refusing to run with the host orca on PATH' <<<"$output" || return 1
  # The caller's PATH is left as it was: nothing points at a missing mirror.
  grep -qx "$FAKE_HOST/agmsg-sentinel" <<<"$output" || return 1
  grep -qx 'bash=ok' <<<"$output" || return 1
  # Nothing half-built is left for a later loader to pick up.
  [ -z "$(find "$MIRROR_ROOT" -mindepth 1 -maxdepth 1 2>/dev/null)" ]
}

_assert_build_refused() {
  [ "$status" -eq 0 ] || return 1
  grep -qx 'load_rc=1' <<<"$output" || return 1
  grep -q 'could not build a complete orca-free mirror' <<<"$output" || return 1
  grep -qx "$FAKE_HOST/agmsg-sentinel" <<<"$output" || return 1
  grep -qx 'bash=ok' <<<"$output" || return 1
  [ -z "$(find "$MIRROR_ROOT" -mindepth 1 -maxdepth 1 2>/dev/null)" ]
}

@test "host orca: a mirror whose links all fail is not published" {
  run _probe 'ln() { if [ "$1" = -s ]; then return 1; fi; command ln "$@"; }
'
  _assert_build_refused
}

@test "host orca: a mirror whose links partly fail is not published" {
  run _probe 'ln() { if [ "$1" = -s ]; then local last="${@: -1}"; command ln "$@"; rm -f "$last/agmsg-sentinel"; return 1; fi; command ln "$@"; }
'
  _assert_build_refused
}

@test "host orca: a mirror missing an entry is not published even when ln reports success" {
  run _probe 'ln() { if [ "$1" = -s ]; then local last="${@: -1}"; command ln "$@"; rm -f "$last/agmsg-sentinel"; return 0; fi; command ln "$@"; }
'
  _assert_build_refused
}

@test "host orca: a pre-existing mirror that still holds orca is refused, not trusted" {
  local key="${FAKE_HOST//\//_}"
  mkdir -p "$MIRROR_ROOT/$key"
  ln -s "$FAKE_HOST/orca" "$MIRROR_ROOT/$key/orca"
  run _probe ''
  [ "$status" -eq 0 ] || return 1
  grep -qx 'load_rc=1' <<<"$output"
}

@test "host orca: parallel loaders share one complete mirror" {
  local i
  for i in 1 2 3 4 5 6 7 8; do
    _probe '' > "$BATS_TEST_TMPDIR/probe.$i" 2>&1 &
  done
  wait $(jobs -p)
  for i in 1 2 3 4 5 6 7 8; do
    grep -qx 'load_rc=0' "$BATS_TEST_TMPDIR/probe.$i" || return 1
    grep -qx 'orca=missing' "$BATS_TEST_TMPDIR/probe.$i" || return 1
    grep -qx "$MIRROR_ROOT/.*/agmsg-sentinel" "$BATS_TEST_TMPDIR/probe.$i" || return 1
  done
  # One published name plus the one temp dir it points at; losers left nothing.
  [ "$(find "$MIRROR_ROOT" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" -eq 2 ]
}

@test "codex profile: setup_test_env drops an inherited CODEX_HOME and the opt-in vars (#39)" {
  export CODEX_HOME="$BATS_TEST_TMPDIR/dev-codex-home"
  export AGMSG_CODEX_HOME="$BATS_TEST_TMPDIR/dev-agmsg-codex-home"
  export ORCA_CODEX_HOME="$BATS_TEST_TMPDIR/dev-orca-codex-home"
  setup_test_env
  [ -z "${CODEX_HOME+x}" ] || return 1
  [ -z "${AGMSG_CODEX_HOME+x}" ] || return 1
  [ -z "${ORCA_CODEX_HOME+x}" ]
}
