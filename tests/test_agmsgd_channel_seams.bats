#!/usr/bin/env bats

@test "agmsgd channel seam regression tests" {
  run node --test "$BATS_TEST_DIRNAME/agmsgd_channel_seams.test.mjs"
  [ "$status" -eq 0 ]
}
