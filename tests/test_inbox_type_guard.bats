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

@test "templates DEFAULT inbox uses --type \$TYPE, never a baked type literal" {
  # Shared SKILL.md is rendered from one type template. A baked
  # `--type claude-code` / `codex` / `grok-build` on the DEFAULT inbox
  # line is wrong for every other caller that then follows that SKILL.md.
  # Identity must keep TYPE as a session variable the same way it keeps
  # AGENT and TEAMS, or Execute runs inbox without knowing the caller type.
  local template count=0 line
  for template in "$BATS_TEST_DIRNAME"/../scripts/drivers/types/*/template.md; do
    [ -f "$template" ] || continue
    count=$((count + 1))
    line="$(awk '
      /If no arguments provided \(DEFAULT action/ { grab = 1 }
      grab && /inbox\.sh/ { print; exit }
    ' "$template")"
    [ -n "$line" ] || { echo "no DEFAULT inbox line: $template" >&2; return 1; }
    printf '%s\n' "$line" | grep -Fq 'inbox.sh $TEAM $AGENT --type $TYPE' \
      || { echo "DEFAULT inbox is not --type \$TYPE: $template"$'\n'"$line" >&2; return 1; }
    if printf '%s\n' "$line" | grep -Eq -- '--type (claude-code|codex|gemini|antigravity|copilot|cursor|opencode|hermes|grok-build)([[:space:]`]|$)'; then
      echo "DEFAULT inbox bakes a type literal: $template"$'\n'"$line" >&2
      return 1
    fi
    grep -Fq 'Remember AGENT, TEAMS, and TYPE' "$template" \
      || { echo "Identity does not remember TYPE: $template" >&2; return 1; }
    grep -q 'already know your AGENT, TEAMS, and TYPE' "$template" \
      || { echo "skip-to-Execute does not require TYPE: $template" >&2; return 1; }
  done
  [ "$count" -eq 9 ]
}
