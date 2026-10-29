#!/usr/bin/env bats

@test "agmsgd Antigravity nudge channel tests" {
  run node --test "$BATS_TEST_DIRNAME/agmsgd_antigravity_nudge.test.mjs"
  [ "$status" -eq 0 ]
}
