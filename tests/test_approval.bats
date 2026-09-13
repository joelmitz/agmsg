#!/usr/bin/env bats

# approval.sh is exercised only against fake terminal binaries. These tests
# prove both the native key routing and the zero-write refusal paths.

load test_helper

_out_has() { printf '%s\n' "$output" | grep -qF -- "$1"; }

setup() {
  setup_test_env
  export SKILL_DIR="$TEST_SKILL_DIR"
  export AGMSG_PLUGIN_DIRS=""
  export FAKEBIN="$TEST_SKILL_DIR/fakebin"
  export ARGV_LOG="$TEST_SKILL_DIR/approval-argv.log"
  mkdir -p "$FAKEBIN" "$TEST_SKILL_DIR/run"
  : > "$ARGV_LOG"
  unset TMUX TMUX_PANE HERDR_ENV HERDR_PANE_ID HERDR_WORKSPACE_ID
}

teardown() { teardown_test_env; }

_write_record() {
  local ref="$1" path
  path="$(bash -c '. "'"$SKILL_DIR"'/scripts/lib/actas-lock.sh"; agmsg_spawn_path testteam alice')"
  [ -n "$path" ]
  printf '%s\t/tmp/project-a\tcodex' "$ref" > "$path"
}

_install_fake_tmux() {
  cat > "$FAKEBIN/tmux" <<EOF
#!/usr/bin/env bash
{ printf 'tmux'; for a in "\$@"; do printf ' [%s]' "\$a"; done; printf '\n'; } >> "$ARGV_LOG"
if [ "\$1" = capture-pane ]; then
  case "\${SCREEN_MODE:-approval}" in
    approval) printf 'Command: git push origin feature\nDo you want to proceed\n  Yes\n  No\n' ;;
    stale) printf 'ordinary idle screen\n' ;;
    unreadable) printf 'capture denied\n' >&2; exit 1 ;;
  esac
fi
exit 0
EOF
  chmod +x "$FAKEBIN/tmux"
  export PATH="$FAKEBIN:$PATH"
}

_install_fake_herdr() {
  cat > "$FAKEBIN/herdr" <<EOF
#!/usr/bin/env bash
{ printf 'herdr'; for a in "\$@"; do printf ' [%s]' "\$a"; done; printf '\n'; } >> "$ARGV_LOG"
if [ "\$1 \$2" = 'pane read' ]; then
  printf 'Command: git push origin feature\nDo you want to proceed\n  Yes\n  No\n'
fi
exit 0
EOF
  chmod +x "$FAKEBIN/herdr"
  export PATH="$FAKEBIN:$PATH"
}

@test "approval: choice is required and invalid choices write nothing" {
  _install_fake_tmux
  _write_record 'tmux:%7'
  run bash "$SCRIPTS/approval.sh" testteam alice
  [ "$status" -eq 2 ]
  _out_has 'Usage: approval.sh <team> <member> <yes|no>'
  [ ! -s "$ARGV_LOG" ]

  run bash "$SCRIPTS/approval.sh" testteam alice maybe
  [ "$status" -eq 2 ]
  _out_has "choice must be exactly 'yes' or 'no'; there is no default"
  [ ! -s "$ARGV_LOG" ]
}

@test "approval: tmux yes rereads the prompt, shows it, then sends Enter once" {
  _install_fake_tmux
  _write_record 'tmux:%7'
  run bash "$SCRIPTS/approval.sh" testteam alice yes
  [ "$status" -eq 0 ]
  _out_has 'Command: git push origin feature'
  _out_has 'Do you want to proceed'
  _out_has 'approval: answered team=testteam member=alice choice=yes terminal=tmux pane=%7'
  [ "$(grep -c '^tmux ' "$ARGV_LOG")" -eq 2 ]
  [ "$(sed -n '2p' "$ARGV_LOG")" = 'tmux [send-keys] [-t] [%7] [Enter]' ]
}

@test "approval: tmux no produces the distinct Down Enter input" {
  _install_fake_tmux
  _write_record 'tmux:%7'
  run bash "$SCRIPTS/approval.sh" testteam alice no
  [ "$status" -eq 0 ]
  [ "$(grep -c '^tmux ' "$ARGV_LOG")" -eq 2 ]
  [ "$(sed -n '2p' "$ARGV_LOG")" = 'tmux [send-keys] [-t] [%7] [Down] [Enter]' ]
}

@test "approval: herdr yes and no use measured pane send-keys sequences" {
  _install_fake_herdr
  _write_record 'herdr:w1:p4'
  run bash "$SCRIPTS/approval.sh" testteam alice yes
  [ "$status" -eq 0 ]
  [ "$(sed -n '2p' "$ARGV_LOG")" = 'herdr [pane] [send-keys] [w1:p4] [Enter]' ]

  : > "$ARGV_LOG"
  run bash "$SCRIPTS/approval.sh" testteam alice no
  [ "$status" -eq 0 ]
  [ "$(sed -n '2p' "$ARGV_LOG")" = 'herdr [pane] [send-keys] [w1:p4] [Down] [Enter]' ]
}

@test "approval: stale case-sensitive marker refuses with zero writes" {
  _install_fake_tmux
  _write_record 'tmux:%7'
  export SCREEN_MODE=stale
  run bash "$SCRIPTS/approval.sh" testteam alice yes
  [ "$status" -eq 14 ]
  _out_has 'refusal=stale'
  [ "$(grep -c '^tmux ' "$ARGV_LOG")" -eq 1 ]

  : > "$ARGV_LOG"
  export SCREEN_MODE=approval
  # The marker is intentionally case-sensitive; lowercase is stale.
  sed -i 's/Do you want to proceed/do you want to proceed/' "$FAKEBIN/tmux"
  run bash "$SCRIPTS/approval.sh" testteam alice yes
  [ "$status" -eq 14 ]
  [ "$(grep -c '^tmux ' "$ARGV_LOG")" -eq 1 ]
}

@test "approval: unreadable screen refuses and performs zero writes" {
  _install_fake_tmux
  _write_record 'tmux:%7'
  export SCREEN_MODE=unreadable
  run bash "$SCRIPTS/approval.sh" testteam alice no
  [ "$status" -eq 12 ]
  _out_has 'refusal=unreadable'
  [ "$(grep -c '^tmux ' "$ARGV_LOG")" -eq 1 ]
  refute grep -q '\[send-keys\]' "$ARGV_LOG"
}

@test "approval: unsupported plain driver refuses before any write" {
  _write_record 'plain:-'
  run bash "$SCRIPTS/approval.sh" testteam alice yes
  [ "$status" -eq 13 ]
  _out_has 'refusal=unsupported'
  _out_has 'reason=approval_capability_missing'
  [ ! -s "$ARGV_LOG" ]
}

@test "approval: unresolved placement refuses before loading a driver" {
  run bash "$SCRIPTS/approval.sh" testteam alice no
  [ "$status" -eq 13 ]
  _out_has 'refusal=placement_unresolved'
  _out_has 'reason=no_placement_record'
  [ ! -s "$ARGV_LOG" ]
}
