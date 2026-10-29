#!/usr/bin/env bats

# poke.sh's public entry point against an antigravity seat (fake tmux serving
# real agy 1.4.9 screens): exit 16 on a confirmation screen (never retried),
# exit 15 on an unlocatable box (still retried), delivery on an idle screen.
# Pins the type.conf -> poke.sh -> safe-poke wiring, so a CLI/manifest change
# that silently drops the guard is caught here, not only in the unit tests.

load test_helper

setup() {
  setup_test_env
  export SKILL_DIR="$TEST_SKILL_DIR"
  export AGMSG_PLUGIN_DIRS=""
  export FAKEBIN="$TEST_SKILL_DIR/fakebin"
  export ARGV_LOG="$TEST_SKILL_DIR/argv.log"
  FIX="$BATS_TEST_DIRNAME/fixtures/agy-1.4.9-screens"
  mkdir -p "$FAKEBIN" "$TEST_SKILL_DIR/run"
  : > "$ARGV_LOG"
  unset TMUX TMUX_PANE HERDR_ENV HERDR_PANE_ID HERDR_WORKSPACE_ID AGMSG_TERMINAL AGMSG_TERMINAL_DRIVER
  local path
  path="$(bash -c '. "'"$SKILL_DIR"'/scripts/lib/actas-lock.sh"; agmsg_spawn_path testteam alice')"
  printf 'tmux:%%5\t/tmp/project-a\tantigravity' > "$path"
  bash "$SCRIPTS/join.sh" testteam alice antigravity /tmp/project-a >/dev/null
}
teardown() { teardown_test_env; }

# fake tmux: capture-pane prints the given screen file; every call is logged.
_fake_tmux_screen() {
  local screen="$1"
  cat > "$FAKEBIN/tmux" <<FAKE
#!/usr/bin/env bash
{ printf 'tmux'; for a in "\$@"; do printf ' [%s]' "\$a"; done; printf '\\n'; } >> "$ARGV_LOG"
case "\$1" in
  capture-pane) cat "$screen" ;;
esac
exit 0
FAKE
  chmod +x "$FAKEBIN/tmux"
  export PATH="$FAKEBIN:$PATH"
}

_reads() { grep -c '^tmux \[capture-pane\]' "$ARGV_LOG" || true; }
_typed() { grep -cE '^tmux \[(send-keys|paste-buffer|load-buffer|set-buffer)' "$ARGV_LOG" || true; }

@test "poke.sh: an agy permission screen exits 16, types nothing, and is not retried" {
  _fake_tmux_screen "$FIX/perm.ansi"
  run bash "$SCRIPTS/poke.sh" testteam alice --retries 2 --retry-delay 0 "hello"
  [ "$status" -eq 16 ] || { echo "status=$status output=$output"; false; }
  printf '%s\n' "$output" | grep -qF "confirmation screen"
  [ "$(_typed)" -eq 0 ]
  READS16="$(_reads)"
  [ "$READS16" -ge 1 ]
  # --retries 0 reads exactly as often: the retries did not run for 16.
  : > "$ARGV_LOG"
  run bash "$SCRIPTS/poke.sh" testteam alice --retries 0 "hello"
  [ "$status" -eq 16 ]
  [ "$(_reads)" -eq "$READS16" ]
}

@test "poke.sh: an agy screen with no locatable box exits 15 and IS retried" {
  printf 'no rule lines here\njust text\n' > "$TEST_SKILL_DIR/nobox.txt"
  _fake_tmux_screen "$TEST_SKILL_DIR/nobox.txt"
  run bash "$SCRIPTS/poke.sh" testteam alice --retries 2 --retry-delay 0 "hello"
  [ "$status" -eq 15 ] || { echo "status=$status output=$output"; false; }
  [ "$(_typed)" -eq 0 ]
  READS15="$(_reads)"
  : > "$ARGV_LOG"
  run bash "$SCRIPTS/poke.sh" testteam alice --retries 0 "hello"
  [ "$status" -eq 15 ]
  # three attempts (initial + 2 retries) read three times as often as one.
  [ "$READS15" -eq $(( $(_reads) * 3 )) ]
}

@test "poke.sh: an agy idle screen delivers" {
  _fake_tmux_screen "$FIX/idle.ansi"
  run bash "$SCRIPTS/poke.sh" testteam alice "hello"
  [ "$status" -eq 0 ] || { echo "status=$status output=$output"; false; }
  [ "$(_typed)" -ge 1 ]
}
