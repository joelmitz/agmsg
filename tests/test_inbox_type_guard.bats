#!/usr/bin/env bats

load test_helper

setup() {
  setup_test_env
  bash "$SCRIPTS/join.sh" testteam alice claude-code /tmp/project-a
  bash "$SCRIPTS/join.sh" testteam bob claude-code /tmp/project-b
}

teardown() {
  teardown_test_env
}

unread_count() {
  bash -c '
    source "'"$SCRIPTS"'/lib/storage.sh"
    agmsg_storage_load
    storage_list_unread testteam "$1"
  ' _ "$1" | grep -c .
}

@test "inbox type guard: matching --type shows unread and marks it read" {
  bash "$SCRIPTS/send.sh" testteam bob alice "same-type ping"
  run bash "$SCRIPTS/inbox.sh" testteam alice --type claude-code
  [ "$status" -eq 0 ]
  [[ "$output" == *"same-type ping"* ]]
  [ "$(unread_count alice)" -eq 0 ]
}

@test "inbox type guard: mismatched --type is non-zero and leaves the message unread" {
  bash "$SCRIPTS/send.sh" testteam bob alice "wrong-type ping"
  run bash "$SCRIPTS/inbox.sh" testteam alice --type codex
  [ "$status" -ne 0 ]
  [[ "$output" == *"type mismatch"* ]]
  [[ "$output" == *"codex"* ]]
  [[ "$output" == *"claude-code"* ]]
  [[ "$output" != *"wrong-type ping"* ]]
  [ "$(unread_count alice)" -eq 1 ]

  run bash "$SCRIPTS/inbox.sh" testteam alice --type claude-code
  [ "$status" -eq 0 ]
  [[ "$output" == *"wrong-type ping"* ]]
  [ "$(unread_count alice)" -eq 0 ]
}

@test "inbox type guard: omitted --type is non-zero and leaves the message unread" {
  bash "$SCRIPTS/send.sh" testteam bob alice "no-type ping"
  run bash "$SCRIPTS/inbox.sh" testteam alice
  [ "$status" -ne 0 ]
  [[ "$output" == *"Usage: inbox.sh"* ]]
  [[ "$output" == *"--type"* ]]
  [[ "$output" != *"no-type ping"* ]]
  [ "$(unread_count alice)" -eq 1 ]

  # Empty store is not a successful skip: omitting --type still fails closed.
  run bash "$SCRIPTS/inbox.sh" testteam bob
  [ "$status" -ne 0 ]
  [[ "$output" == *"Usage: inbox.sh"* ]]
}

@test "inbox type guard: destination with empty registrations is non-zero" {
  bash "$SCRIPTS/send.sh" testteam bob alice "no dest types"
  local cfg="$TEST_SKILL_DIR/teams/testteam/config.json"
  local updated
  updated="$(sqlite_mem "SELECT json_set(CAST(readfile('$(rf "$cfg")') AS TEXT), '\$.agents.alice.registrations', json('[]'));")"
  printf '%s' "$updated" > "$cfg"

  run bash "$SCRIPTS/inbox.sh" testteam alice --type claude-code
  [ "$status" -ne 0 ]
  [[ "$output" == *"no types"* ]]
  [[ "$output" != *"no dest types"* ]]
  [ "$(unread_count alice)" -eq 1 ]
}

@test "inbox type guard: --quiet and --type may appear in either order" {
  bash "$SCRIPTS/send.sh" testteam bob alice "quiet then type"
  run bash "$SCRIPTS/inbox.sh" testteam alice --quiet --type claude-code
  [ "$status" -eq 0 ]
  [[ "$output" == *"quiet then type"* ]]
  [ "$(unread_count alice)" -eq 0 ]

  bash "$SCRIPTS/send.sh" testteam bob alice "type then quiet"
  run bash "$SCRIPTS/inbox.sh" testteam alice --type claude-code --quiet
  [ "$status" -eq 0 ]
  [[ "$output" == *"type then quiet"* ]]
  [ "$(unread_count alice)" -eq 0 ]
}

@test "inbox type guard: legacy agents.<name>.type is accepted" {
  mkdir -p "$TEST_SKILL_DIR/teams/oldteam"
  cat > "$TEST_SKILL_DIR/teams/oldteam/config.json" <<'JSON'
{
  "name": "oldteam",
  "agents": {
    "alice": { "type": "claude-code", "project": "/tmp/old-a" },
    "bob": { "type": "codex", "project": "/tmp/old-b" }
  },
  "created_at": "2026-01-01T00:00:00Z"
}
JSON
  bash "$SCRIPTS/send.sh" oldteam bob alice "legacy type ping" --force
  run bash "$SCRIPTS/inbox.sh" oldteam alice --type claude-code
  [ "$status" -eq 0 ]
  [[ "$output" == *"legacy type ping"* ]]

  bash "$SCRIPTS/send.sh" oldteam alice bob "legacy mismatch" --force
  run bash "$SCRIPTS/inbox.sh" oldteam bob --type claude-code
  [ "$status" -ne 0 ]
  [[ "$output" == *"type mismatch"* ]]
}
