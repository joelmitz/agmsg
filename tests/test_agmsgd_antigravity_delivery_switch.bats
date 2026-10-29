#!/usr/bin/env bats
# Offering agmsgd for Antigravity and switching a project to it. Isolated
# scripts and data; no service manager, no real agy, nothing is enabled.

refute() { if "$@"; then return 1; fi; return 0; }

setup() {
  export TEST_SKILL_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agy-switch.XXXXXX")"
  TEST_SKILL_DIR="$(cd "$TEST_SKILL_DIR" && pwd -P)"
  cp -R "$BATS_TEST_DIRNAME/../scripts" "$TEST_SKILL_DIR/scripts"
  export SCRIPTS="$TEST_SKILL_DIR/scripts"
  mkdir -p "$TEST_SKILL_DIR/run" "$TEST_SKILL_DIR/db" "$TEST_SKILL_DIR/project"
  export AGMSG_CONFIG="$TEST_SKILL_DIR/config.json"
  export AGMSG_STORAGE_PATH="$TEST_SKILL_DIR/db"
  sqlite3 "$TEST_SKILL_DIR/run/install.db" < "$SCRIPTS/daemon/schema.sql"
  export PROJECT="$TEST_SKILL_DIR/project"
  # The offer gate asks systemd whether user services work; answer yes without
  # touching the host's service manager.
  mkdir -p "$TEST_SKILL_DIR/bin"
  printf '#!/bin/sh\nexit 0\n' > "$TEST_SKILL_DIR/bin/systemctl"
  chmod +x "$TEST_SKILL_DIR/bin/systemctl"
  export AGMSGD_SYSTEMCTL="$TEST_SKILL_DIR/bin/systemctl"
  export MSG_UNAVAILABLE="agmsgd=unavailable reason=agmsgd does not deliver to antigravity sessions"
}

_mark_daemon_ready() {
  local boot
  case "$(uname -s)" in
    Darwin) boot="$(sysctl -n kern.bootsessionuuid)" ;;
    Linux) boot="$(sed -n 's/^btime //p' /proc/stat)" ;;
    *) skip 'POSIX beta executor evidence' ;;
  esac
  sqlite3 "$TEST_SKILL_DIR/run/install.db" "UPDATE meta SET node_path='$(command -v node)'; UPDATE daemon_intent SET desired='on';
    UPDATE daemon_owner SET state='ready', executor_pid=$$, executor_boot_id='$boot', executor_started_at=strftime('%Y-%m-%dT%H:%M:%fZ','now');"
}

teardown() { rm -rf "$TEST_SKILL_DIR"; }

@test "offer: Antigravity stays unavailable unless its delivery file exists (observation or live files do not count)" {
  run bash "$SCRIPTS/daemon.sh" offer antigravity
  [ "$status" -eq 0 ]
  [ "$output" = "$MSG_UNAVAILABLE" ]
  : > "$TEST_SKILL_DIR/run/observe-antigravity"
  : > "$TEST_SKILL_DIR/run/agmsgd-antigravity-live"
  run bash "$SCRIPTS/daemon.sh" offer antigravity
  [ "$output" = "$MSG_UNAVAILABLE" ]
  ln -s "$TEST_SKILL_DIR/run/observe-antigravity" "$TEST_SKILL_DIR/run/agmsgd-antigravity-delivery"
  run bash "$SCRIPTS/daemon.sh" offer antigravity
  [ "$output" = "$MSG_UNAVAILABLE" ]
}

@test "offer: with the delivery file Antigravity is offered like the other types; the others are unchanged" {
  : > "$TEST_SKILL_DIR/run/agmsgd-antigravity-delivery"
  run bash "$SCRIPTS/daemon.sh" offer antigravity
  [ "$output" = "agmsgd=available" ]
  run bash "$SCRIPTS/daemon.sh" offer claude-code
  [ "$output" = "agmsgd=available" ]
  run bash "$SCRIPTS/daemon.sh" offer codex
  [ "$output" = "agmsgd=available" ]
  run bash "$SCRIPTS/daemon.sh" offer gemini
  [ "$output" = "agmsgd=unavailable reason=agmsgd does not deliver to gemini sessions" ]
}

@test "delivery agmsgd for Antigravity without the delivery file: refused, nothing written" {
  _mark_daemon_ready
  run bash "$SCRIPTS/agmsg" delivery agmsgd --type antigravity --project "$PROJECT"
  [ "$status" -ne 0 ]
  grep -Fq "agmsgd is not available here" <<<"$output"
  [ ! -e "$TEST_SKILL_DIR/run/delivery-choice" ]
  [ ! -e "$PROJECT/.agent/rules/agmsg.md" ]
}

@test "delivery agmsgd for Antigravity: the rule file becomes the turn rule (never the monitor marker) and the choice is recorded" {
  _mark_daemon_ready
  : > "$TEST_SKILL_DIR/run/agmsgd-antigravity-delivery"
  bash "$SCRIPTS/delivery.sh" set monitor antigravity "$PROJECT" >/dev/null
  grep -Fq "agmsg:antigravity:monitor" "$PROJECT/.agent/rules/agmsg.md"
  run bash "$SCRIPTS/agmsg" delivery agmsgd --type antigravity --project "$PROJECT"
  [ "$status" -eq 0 ]
  refute grep -Fq "agmsg:antigravity:monitor" "$PROJECT/.agent/rules/agmsg.md"
  grep -Fq "check-inbox.sh" "$PROJECT/.agent/rules/agmsg.md"
  [ "$(cut -f1,3 "$TEST_SKILL_DIR/run/delivery-choice")" = "$(printf 'antigravity\tagmsgd')" ]
}

@test "delivery agmsgd for Antigravity: a running TUI monitor refuses the switch and nothing changes" {
  [ "$(uname -s)" = Linux ] || skip 'process identity is read from /proc'
  _mark_daemon_ready
  : > "$TEST_SKILL_DIR/run/agmsgd-antigravity-delivery"
  bash "$SCRIPTS/delivery.sh" set monitor antigravity "$PROJECT" >/dev/null
  start="$(sed 's/^.*) //' "/proc/$$/stat" | cut -d' ' -f20)"
  node -e '
    const fs = require("fs"); const [run, project, pid, start] = process.argv.slice(1);
    fs.writeFileSync(`${run}/state.json`, JSON.stringify({ project, team: "t", role: "a" }));
    fs.writeFileSync(`${run}/read-reservation.t__a.json`, JSON.stringify({ type: "antigravity", kind: "tui-pty", pid: Number(pid), start, state: `${run}/state.json` }));
  ' "$TEST_SKILL_DIR/run" "$PROJECT" "$$" "$start"
  run bash "$SCRIPTS/agmsg" delivery agmsgd --type antigravity --project "$PROJECT"
  [ "$status" -ne 0 ]
  grep -Fq "delivery is unchanged" <<<"$output"
  grep -Fq "agmsg:antigravity:monitor" "$PROJECT/.agent/rules/agmsg.md"
  [ ! -e "$TEST_SKILL_DIR/run/delivery-choice" ]
}

@test "delivery agmsgd for claude-code and codex still takes the paths it had" {
  _mark_daemon_ready
  run bash "$SCRIPTS/agmsg" delivery agmsgd --type claude-code --project "$PROJECT"
  [ "$status" -eq 0 ]
  grep -Fq "agmsgd delivers to this project" <<<"$output"
  run bash "$SCRIPTS/agmsg" delivery agmsgd --type codex --project "$PROJECT"
  [ "$status" -eq 0 ]
  grep -Fq "This session keeps its current delivery" <<<"$output"
}
