#!/usr/bin/env bats

load test_helper

setup() {
  setup_test_env
  export GUARD="$TYPES/codex/codex-process-guard.sh"
  chmod +x "$GUARD"
}

teardown() {
  teardown_test_env
}

@test "process guard: protects the current shell chain" {
  run bash "$GUARD" inspect "$$" '*'
  [ "$status" -eq 1 ]
  [[ "$output" == "REJECT current-process-chain" ]]
}

@test "process guard: protects a multi-level ancestor chain" {
  run bash -c "bash -c 'bash \"$GUARD\" inspect \"\$PPID\" \"*\"'"
  [ "$status" -eq 1 ]
  [[ "$output" == "REJECT current-process-chain" ]]
}

@test "process guard: refuses a missing target as UNKNOWN" {
  run bash "$GUARD" inspect 2147483647 '*anything*'
  [ "$status" -eq 2 ]
  [[ "$output" == "UNKNOWN target-not-observable" ]]
}

@test "process guard: rejects mismatched command lines" {
  run bash "$GUARD" inspect "$$" '*__definitely_not_a_process__*'
  [ "$status" -eq 1 ]
  [[ "$output" == REJECT\ args-mismatch\ args=* ]]
}
