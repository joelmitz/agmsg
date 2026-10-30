#!/usr/bin/env bats
#
# The rendered Antigravity skill must read the inbox with check-inbox.sh (type as an
# argument), not inbox.sh: Antigravity's manifest declares detect=explicit (no built-in
# environment marker), so inbox.sh does not detect it automatically; in the measured setup
# the detected type was empty and it failed, and nothing was marked read. The monitor
# prohibition must stay, and the status step is skipped only on Windows, where no
# Antigravity monitor can run.
load test_helper

setup() {
  setup_test_env
  # shellcheck disable=SC1091
  source "$BATS_TEST_DIRNAME/../scripts/lib/type-registry.sh"
  # shellcheck disable=SC1091
  source "$BATS_TEST_DIRNAME/../scripts/lib/skill-render.sh"
  OUT="$TEST_SKILL_DIR/rendered-antigravity.md"
  SCRIPT_DIR="$BATS_TEST_DIRNAME/.." agmsg_render_skill antigravity agmsg "$OUT"
}
teardown() { teardown_test_env; }

@test "antigravity skill: the manifest still declares detect=explicit (the reason inbox.sh fails)" {
  [ "$(agmsg_type_get antigravity detect)" = "explicit" ]
}

@test "antigravity skill: the wording states the limit of the type detection, not a general claim" {
  grep -qF 'cannot reliably be used here' "$OUT"
  grep -qF 'In the measured setup the detected type was empty' "$OUT"
  grep -qF 'with another type'"'"'s marker in the environment it could instead fail with a type mismatch' "$OUT"
}

@test "antigravity skill: reading uses check-inbox.sh with the type and project as arguments" {
  grep -qF 'scripts/check-inbox.sh antigravity "$(pwd)"' "$OUT"
  grep -qF 'instead of `inbox.sh $TEAM $AGENT`' "$OUT"
}

@test "antigravity skill: it tells the agent not to fall back to history.sh and not to loop on an empty result" {
  grep -qF 'Do not fall back to `history.sh`' "$OUT"
  grep -qF 'do not repeat it in a loop' "$OUT"
  grep -qF 'do not pass a team or a role' "$OUT"
  grep -qF 'replaces the shared default'"'"'s per-TEAM `inbox.sh` loop and runs once for the project' "$OUT"
  grep -qF 'do not run the shared default inbox read before the monitor check below' "$OUT"
}

@test "antigravity skill: the monitor prohibition is kept and the read is conditional on no monitor" {
  grep -qF 'When no TUI monitor owns this seat' "$OUT"
  grep -qF 'the prohibition below stays in force' "$OUT"
  grep -qF 'do not apply that default behavior**, and do not call bare' "$OUT"
  grep -qF 'or `check-inbox.sh`. Use this status command' "$OUT"
  grep -qF 'AGMSG_RECEIVED:<batch-id>' "$OUT"
}

@test "antigravity skill: the status step is skipped only on Windows, with the reason, and kept elsewhere" {
  grep -qF 'On Windows' "$OUT"
  grep -qF '`$env:OS` is `Windows_NT`' "$OUT"
  grep -qF 'both Antigravity monitors' "$OUT"
  grep -qF 'POSIX-only and cannot be running there' "$OUT"
  grep -qF 'On any other OS, first run `bash ~/.agents/skills/agmsg/scripts/drivers/types/antigravity/antigravity-tui-monitor.sh status' "$OUT"
}

@test "antigravity skill: only the intended slot changed; other types' rendering is unaffected" {
  # the shared base default still names inbox.sh (other types use it); the overlay is what redirects Antigravity
  grep -qF 'scripts/inbox.sh $TEAM $AGENT' "$OUT"
  local cc="$TEST_SKILL_DIR/rendered-claude-code.md"
  SCRIPT_DIR="$BATS_TEST_DIRNAME/.." agmsg_render_skill claude-code agmsg "$cc"
  ! grep -qF 'Reading the inbox in Antigravity' "$cc"
}
