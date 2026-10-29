#!/usr/bin/env bats

# agy (Antigravity CLI 1.4.9) real screens as fixtures: the input box is
# recognised on idle/busy, a real draft refuses (14), and a confirmation
# (permission) screen refuses with its OWN code (16) rather than by accident.
# Fixtures: tests/fixtures/agy-1.4.9-screens/{idle,draft,busy,perm}.ansi
# (captured from a real session; styled, last ~24 lines, no account details).

load test_helper

setup() {
  setup_test_env
  export SKILL_DIR="$TEST_SKILL_DIR"
  FIX="$BATS_TEST_DIRNAME/fixtures/agy-1.4.9-screens"
  POKE_LOG="$TEST_SKILL_DIR/poke.log"; : > "$POKE_LOG"
  # shellcheck disable=SC1091
  source "$SKILL_DIR/scripts/lib/safe-poke.sh"
  # shellcheck disable=SC1091
  source "$SKILL_DIR/scripts/lib/type-registry.sh"
  terminal_poke() { printf '%s %s\n' "$1" "$2" >> "$POKE_LOG"; return 0; }
  terminal_peek_styled() { cat "$SCREEN"; }
  MARKER="$(agmsg_type_get antigravity input_prompt_marker)"
  BOXED="$(agmsg_type_get antigravity input_prompt_boxed)"
  REFUSE="$(agmsg_type_get antigravity input_refuse_screen)"
  MAXT="$(agmsg_type_get antigravity input_max_trailing_lines)"
}
teardown() { teardown_test_env; }

poke_with() {   # <fixture name>
  SCREEN="$FIX/$1.ansi"
  agmsg_safe_poke pane-1 "text" "$MARKER" "$BOXED" t a \
    --refuse-screen "$REFUSE" --max-trailing "$MAXT"
}

@test "agy manifest declares the box recognition and the refuse list" {
  [ "$MARKER" = ">" ]
  [ "$BOXED" = yes ]
  [ -n "$REFUSE" ]
  [ "$MAXT" = 3 ]
}

@test "agy idle screen: box located, empty -> poke goes out" {
  run poke_with idle
  [ "$status" -eq 0 ]
  [ "$(cat "$POKE_LOG")" = "pane-1 text" ]
}

@test "agy busy screen (esc to cancel footer, empty box): poke goes out (agy queues it)" {
  run poke_with busy
  [ "$status" -eq 0 ]
  [ "$(cat "$POKE_LOG")" = "pane-1 text" ]
}

@test "agy draft screen: real draft refuses with 14, nothing typed" {
  run poke_with draft
  [ "$status" -eq 14 ]
  [ ! -s "$POKE_LOG" ]
}

@test "agy permission screen: refuses with its own code 16, nothing typed" {
  run poke_with perm
  [ "$status" -eq 16 ]
  [ ! -s "$POKE_LOG" ]
}

@test "regression: without the new guards the permission screen is refused only by accident (14), and 16 is not reachable" {
  SCREEN="$FIX/perm.ansi"
  run agmsg_safe_poke pane-1 "text" "$MARKER" "$BOXED" t a
  [ "$status" -eq 14 ]
}

@test "structure guard alone: a permission-like screen with a long tail below the last rule is 15, not a poke" {
  SCREEN="$FIX/perm.ansi"
  run agmsg_safe_poke pane-1 "text" "$MARKER" "$BOXED" t a --max-trailing 3
  [ "$status" -eq 15 ]
  [ ! -s "$POKE_LOG" ]
}

@test "a transcript line merely quoting the refuse text ABOVE the last rule does not block" {
  SCREEN="$TEST_SKILL_DIR/quoted.ansi"
  { echo "  Requesting permission for: (quoted in an old answer)"; cat "$FIX/idle.ansi"; } > "$SCREEN"
  run agmsg_safe_poke pane-1 "text" "$MARKER" "$BOXED" t a --refuse-screen "$REFUSE" --max-trailing "$MAXT"
  [ "$status" -eq 0 ]
}
