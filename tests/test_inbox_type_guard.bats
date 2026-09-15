#!/usr/bin/env bats

load test_helper

setup() {
  setup_test_env
  agmsg_clear_session_detect_env
  bash "$SCRIPTS/join.sh" testteam alice claude-code /tmp/project-a
  bash "$SCRIPTS/join.sh" testteam bob claude-code /tmp/project-b
  bash "$SCRIPTS/join.sh" testteam carol grok-build /tmp/project-c
  FAKEBIN="$BATS_TEST_TMPDIR/bin"; mkdir -p "$FAKEBIN"
  ARGV_LOG="$BATS_TEST_TMPDIR/argv.log"; : > "$ARGV_LOG"
  export FAKEBIN ARGV_LOG
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

# Opt into self-naming against a fake tmux so a refused inbox can be checked
# for "did not name / did not rename".
enable_naming() {
  unset AGMSG_SELF_NAME AGMSG_SELF_RENAME
  agmsg_install_fake_tmux
  export TMUX="/tmp/s,4242,0" TMUX_PANE="%3"
  : > "$ARGV_LOG"
}

name_calls() {
  grep -cE '\[set-option\] \[-p\]' "$ARGV_LOG" || true
}

run_inbox() {
  # stdout and stderr split: refuse must not print the body on stdout.
  local st=0
  env "$@" bash "$SCRIPTS/inbox.sh" "${INBOX_TEAM:-testteam}" "${INBOX_AGENT:-alice}" \
    >"$TEST_SKILL_DIR/inbox.out" 2>"$TEST_SKILL_DIR/inbox.err" || st=$?
  INBOX_STATUS="$st"
}

assert_refused_unread() {
  local agent="$1" body="$2" before="$3"
  [ "$INBOX_STATUS" -ne 0 ]
  [ ! -s "$TEST_SKILL_DIR/inbox.out" ]
  if [ -n "$body" ]; then
    grep -Fq -- "$body" "$TEST_SKILL_DIR/inbox.out" && return 1
  fi
  [ "$(unread_count "$agent")" -eq "$before" ]
}

@test "inbox type guard: grok env against claude dest refuses without body, mark, or naming" {
  bash "$SCRIPTS/send.sh" testteam bob alice "grok-to-claude"
  enable_naming
  local before; before="$(unread_count alice)"
  [ "$before" -eq 1 ]
  run_inbox GROK_SESSION_ID=grok-sess
  assert_refused_unread alice "grok-to-claude" "$before"
  [ "$(name_calls)" -eq 0 ]
}

@test "inbox type guard: claude env against claude alias dest succeeds" {
  bash "$SCRIPTS/send.sh" testteam bob alice "alias-ok"
  run_inbox CLAUDE_CODE_SESSION_ID=claude-sess
  [ "$INBOX_STATUS" -eq 0 ]
  grep -Fq -- "alias-ok" "$TEST_SKILL_DIR/inbox.out"
  [ "$(unread_count alice)" -eq 0 ]
}

@test "inbox type guard: other type refuses without body, mark, or naming" {
  bash "$SCRIPTS/send.sh" testteam alice carol "claude-to-grok"
  enable_naming
  local before; before="$(unread_count carol)"
  INBOX_AGENT=carol run_inbox CLAUDE_CODE_SESSION_ID=claude-sess
  assert_refused_unread carol "claude-to-grok" "$before"
  [ "$(name_calls)" -eq 0 ]
}

@test "inbox type guard: no env is refused" {
  bash "$SCRIPTS/send.sh" testteam bob alice "no-env"
  local before; before="$(unread_count alice)"
  run_inbox
  assert_refused_unread alice "no-env" "$before"
  grep -Fq "caller type not detected" "$TEST_SKILL_DIR/inbox.err"
}

@test "inbox type guard: detect=explicit (no strong marker) is refused" {
  bash "$SCRIPTS/join.sh" testteam agy antigravity /tmp/project-agy
  bash "$SCRIPTS/send.sh" testteam bob agy "explicit-dest"
  local before; before="$(unread_count agy)"
  INBOX_AGENT=agy run_inbox
  assert_refused_unread agy "explicit-dest" "$before"
}

@test "inbox type guard: --type is unexpected" {
  bash "$SCRIPTS/send.sh" testteam bob alice "no-flag"
  local before; before="$(unread_count alice)"
  local st=0
  env CLAUDE_CODE_SESSION_ID=claude-sess bash "$SCRIPTS/inbox.sh" testteam alice --type claude-code \
    >"$TEST_SKILL_DIR/inbox.out" 2>"$TEST_SKILL_DIR/inbox.err" || st=$?
  INBOX_STATUS="$st"
  assert_refused_unread alice "no-flag" "$before"
  grep -Fq "unexpected argument: --type" "$TEST_SKILL_DIR/inbox.err"
}

@test "inbox type guard: extra args besides --quiet are refused" {
  local st=0
  env CLAUDE_CODE_SESSION_ID=claude-sess bash "$SCRIPTS/inbox.sh" testteam alice --quiet --extra \
    >"$TEST_SKILL_DIR/inbox.out" 2>"$TEST_SKILL_DIR/inbox.err" || st=$?
  [ "$st" -ne 0 ]
  [ ! -s "$TEST_SKILL_DIR/inbox.out" ]
  grep -Fq "unexpected argument: --extra" "$TEST_SKILL_DIR/inbox.err"
}

@test "inbox type guard: missing dest is refused" {
  local st=0
  env CLAUDE_CODE_SESSION_ID=claude-sess bash "$SCRIPTS/inbox.sh" testteam nobody \
    >"$TEST_SKILL_DIR/inbox.out" 2>"$TEST_SKILL_DIR/inbox.err" || st=$?
  [ "$st" -ne 0 ]
  [ ! -s "$TEST_SKILL_DIR/inbox.out" ]
  grep -Fq "not on the roster" "$TEST_SKILL_DIR/inbox.err"
}

@test "inbox type guard: empty dest type is refused" {
  bash "$SCRIPTS/join.sh" testteam empty claude-code /tmp/project-empty
  python3 -c '
import json,sys
p=sys.argv[1]
c=json.load(open(p))
c["agents"]["empty"]["registrations"][0]["type"]=""
open(p,"w").write(json.dumps(c))
' "$TEST_SKILL_DIR/teams/testteam/config.json"
  bash "$SCRIPTS/send.sh" testteam bob empty "empty-type"
  local before; before="$(unread_count empty)"
  INBOX_AGENT=empty run_inbox CLAUDE_CODE_SESSION_ID=claude-sess
  assert_refused_unread empty "empty-type" "$before"
  grep -Fq "has no types" "$TEST_SKILL_DIR/inbox.err"
}

@test "inbox type guard: two types at once are refused" {
  bash "$SCRIPTS/send.sh" testteam bob alice "two-types"
  local before; before="$(unread_count alice)"
  run_inbox CLAUDE_CODE_SESSION_ID=claude-sess CODEX_THREAD_ID=thread-1
  assert_refused_unread alice "two-types" "$before"
}

@test "inbox type guard: CODEX_SANDBOX + CODEX_THREAD_ID is one type and succeeds" {
  bash "$SCRIPTS/join.sh" testteam dex codex /tmp/project-dex
  bash "$SCRIPTS/send.sh" testteam bob dex "same-type-markers"
  INBOX_AGENT=dex run_inbox CODEX_SANDBOX=seat CODEX_THREAD_ID=thread-1
  [ "$INBOX_STATUS" -eq 0 ]
  grep -Fq -- "same-type-markers" "$TEST_SKILL_DIR/inbox.out"
  [ "$(unread_count dex)" -eq 0 ]
}

@test "inbox type guard: CODEX_SANDBOX only succeeds for a codex dest" {
  bash "$SCRIPTS/join.sh" testteam dex2 codex /tmp/project-dex2
  bash "$SCRIPTS/send.sh" testteam bob dex2 "sandbox-only"
  INBOX_AGENT=dex2 run_inbox CODEX_SANDBOX=seat
  [ "$INBOX_STATUS" -eq 0 ]
  grep -Fq -- "sandbox-only" "$TEST_SKILL_DIR/inbox.out"
}

@test "inbox type guard: CODEX_THREAD_ID only succeeds for a codex dest" {
  bash "$SCRIPTS/join.sh" testteam dex3 codex /tmp/project-dex3
  bash "$SCRIPTS/send.sh" testteam bob dex3 "thread-only"
  INBOX_AGENT=dex3 run_inbox CODEX_THREAD_ID=thread-1
  [ "$INBOX_STATUS" -eq 0 ]
  grep -Fq -- "thread-only" "$TEST_SKILL_DIR/inbox.out"
}

@test "inbox type guard: neither Codex marker against a codex dest is refused" {
  bash "$SCRIPTS/join.sh" testteam dex4 codex /tmp/project-dex4
  bash "$SCRIPTS/send.sh" testteam bob dex4 "no-codex-env"
  local before; before="$(unread_count dex4)"
  INBOX_AGENT=dex4 run_inbox
  assert_refused_unread dex4 "no-codex-env" "$before"
}

@test "inbox type guard: GEMINI_API_KEY alone is refused" {
  bash "$SCRIPTS/join.sh" testteam gem gemini /tmp/project-gem
  bash "$SCRIPTS/send.sh" testteam bob gem "weak-only"
  local before; before="$(unread_count gem)"
  INBOX_AGENT=gem run_inbox GEMINI_API_KEY=secret
  assert_refused_unread gem "weak-only" "$before"
}

@test "helper: prints registry strong detect keys and omits fallback/explicit" {
  run bash "$SCRIPTS/lib/print-strong-detect-env-keys.sh"
  [ "$status" -eq 0 ]
  printf '%s\n' "$output" | grep -qx CLAUDE_CODE_SESSION_ID
  printf '%s\n' "$output" | grep -qx CODEX_THREAD_ID
  printf '%s\n' "$output" | grep -qx CODEX_SANDBOX
  printf '%s\n' "$output" | grep -qx GROK_SESSION_ID
  printf '%s\n' "$output" | grep -qx GEMINI_CLI
  [ "$(printf '%s\n' "$output" | grep -cx GEMINI_API_KEY || true)" -eq 0 ]
  [ "$(printf '%s\n' "$output" | grep -cx explicit || true)" -eq 0 ]
}

@test "helper: trusted plugin detect= appears; fallback and explicit do not" {
  local plug="$TEST_SKILL_DIR/plugins/types/agmsg-test-strong"
  mkdir -p "$plug"
  printf '%s\n' 'name=agmsg-test-strong' 'detect=AGMSG_TEST_STRONG_MARKER' 'detect_fallback=AGMSG_TEST_FALLBACK_MARKER' > "$plug/type.conf"
  local expl="$TEST_SKILL_DIR/plugins/types/agmsg-test-explicit"
  mkdir -p "$expl"
  printf '%s\n' 'name=agmsg-test-explicit' 'detect=explicit' > "$expl/type.conf"
  bash "$SCRIPTS/plugin.sh" trust types/agmsg-test-strong
  bash "$SCRIPTS/plugin.sh" trust types/agmsg-test-explicit
  run bash "$SCRIPTS/lib/print-strong-detect-env-keys.sh"
  [ "$status" -eq 0 ]
  printf '%s\n' "$output" | grep -qx AGMSG_TEST_STRONG_MARKER
  [ "$(printf '%s\n' "$output" | grep -cx AGMSG_TEST_FALLBACK_MARKER || true)" -eq 0 ]
  [ "$(printf '%s\n' "$output" | grep -cx explicit || true)" -eq 0 ]
}

@test "from_env: same-type markers succeed and mixed types are empty" {
  detect() {
    env -i PATH="$PATH" "$@" bash -c \
      "source '$SCRIPTS/lib/type-registry.sh'; source '$SCRIPTS/lib/detect-cli-type.sh'; agmsg_detect_cli_type_from_env"
  }
  [ "$(detect CLAUDE_CODE_SESSION_ID=x)" = claude-code ]
  [ "$(detect CODEX_SANDBOX=s CODEX_THREAD_ID=t)" = codex ]
  [ -z "$(detect CLAUDE_CODE_SESSION_ID=x CODEX_THREAD_ID=y)" ]
  [ -z "$(detect)" ]
  [ -z "$(detect GEMINI_API_KEY=x)" ]
  [ "$(detect GEMINI_CLI=1)" = gemini ]
}
