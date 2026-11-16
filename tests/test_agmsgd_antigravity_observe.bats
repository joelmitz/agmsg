#!/usr/bin/env bats

setup() {
  export TEST_SKILL_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agy-observe.XXXXXX")"
  TEST_SKILL_DIR="$(cd "$TEST_SKILL_DIR" && pwd -P)"
  cp -R "$BATS_TEST_DIRNAME/../scripts" "$TEST_SKILL_DIR/scripts"
  mkdir -p "$TEST_SKILL_DIR/run" "$TEST_SKILL_DIR/db"
  export AGMSG_CONFIG="$TEST_SKILL_DIR/config.json"
  export AGMSG_STORAGE_PATH="$TEST_SKILL_DIR/db"
  sqlite3 "$TEST_SKILL_DIR/run/install.db" < "$TEST_SKILL_DIR/scripts/daemon/schema.sql"
}

teardown() { rm -rf "$TEST_SKILL_DIR"; }

@test "agmsgd Antigravity observation tests" {
  skip "fork 独自の agy 機構。upstream 1.7.4 同期で agy は上流優先とし、type.conf/channel 登録を上流へ寄せたため休止中(廃止または再統合の判断待ち)"
  run node --test "$BATS_TEST_DIRNAME/agmsgd_antigravity_observe.test.mjs"
  [ "$status" -eq 0 ]
}

@test "offer still says agmsgd does not deliver to Antigravity, even with observation on" {
  run bash "$TEST_SKILL_DIR/scripts/daemon.sh" offer antigravity
  [ "$status" -eq 0 ]
  [ "$output" = "agmsgd=unavailable reason=agmsgd does not deliver to antigravity sessions" ]
  : > "$TEST_SKILL_DIR/run/observe-antigravity"
  run bash "$TEST_SKILL_DIR/scripts/daemon.sh" offer antigravity
  [ "$output" = "agmsgd=unavailable reason=agmsgd does not deliver to antigravity sessions" ]
  run bash "$TEST_SKILL_DIR/scripts/daemon.sh" offer claude-code
  [ "$output" = "agmsgd=available" ]
}
