#!/usr/bin/env bats

@test "agmsgd Antigravity nudge channel tests" {
  skip "fork 独自の agy 機構。upstream 1.7.4 同期で agy は上流優先とし、type.conf/channel 登録を上流へ寄せたため休止中(廃止または再統合の判断待ち)"
  run node --test "$BATS_TEST_DIRNAME/agmsgd_antigravity_nudge.test.mjs"
  [ "$status" -eq 0 ]
}
