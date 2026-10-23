#!/usr/bin/env bats
#
# teardown_test_env must kill a detached process still holding $TEST_SKILL_DIR before
# it removes the tree. The detached codex children (codex-bridge-launcher.sh and the
# codex-bridge.js it starts) outlive the test body and keep writing $TEST_SKILL_DIR/run,
# so the bare rm races them and fails "Directory not empty" (#662 == #1036 == #1049).
# The reaper is scoped to the unique mktemp $TEST_SKILL_DIR so it can never reach a real
# bridge or another test — that scope safety is asserted here, not just the kill.
#
# Assertions use plain commands / `refute`, never a non-last `[[ ]]` or `! cmd` (#670).

load test_helper

setup() { setup_test_env; }
# Every orphan _start_orphan made is stopped here, before teardown_test_env, so a
# failed assertion cannot leave one behind. Where the reaper reads `ps` argv only
# (no /proc), an orphan that names TEST_SKILL_DIR only in its environment is
# invisible to it -- and such an orphan still holds a descriptor bats waits on,
# which hung a macOS shard to the 30-minute cap. The pids are ones this file
# started itself, so they are signalled directly.
teardown() {
  local p
  if [ -f "$BATS_TEST_TMPDIR/orphans.pids" ]; then
    while IFS= read -r p; do
      case "$p" in ''|0|1|*[!0-9]*) continue ;; esac
      kill "$p" 2>/dev/null || true
    done < "$BATS_TEST_TMPDIR/orphans.pids"
  fi
  teardown_test_env
}

# Spawn a detached holder whose argv carries $TEST_SKILL_DIR (as the launcher's does),
# keeping run/ busy. Echoes its pid once it is actually writing run/.
_start_holder() {
  mkdir -p "$TEST_SKILL_DIR/run"
  local holder="$TEST_SKILL_DIR/scripts/holder.sh"
  cat > "$holder" <<'H'
#!/usr/bin/env bash
d="$1"; while :; do : > "$d/run/held.$$"; sleep 0.05; done
H
  chmod +x "$holder"
  # ORPHAN it in a subshell (the subshell exits, the holder reparents to init) so it
  # matches the real detached launcher — and so that after the reaper's SIGKILL it is
  # reaped by init rather than lingering as a zombie of this test shell, which would
  # still answer `kill -0` and defeat the "it is dead" assertion. It records its own pid.
  # Close the command substitution's stdout/stderr: leaving either descriptor open in
  # the orphan makes the caller wait for EOF forever before it can reap the holder.
  ( "$holder" "$TEST_SKILL_DIR" </dev/null >/dev/null 2>&1 & printf '%s\n' "$!" > "$TEST_SKILL_DIR/holder.pid" )
  local hp; hp="$(cat "$TEST_SKILL_DIR/holder.pid" 2>/dev/null)"
  _wait_for_holder_ready "$TEST_SKILL_DIR/run/held.$hp" || {
    echo "holder $hp did not become ready before the bounded wait expired" >&2
    return 1
  }
  printf '%s\n' "$hp"
}

# Wait for the holder to prove it is writing run/, with an explicit ceiling. Keep the
# knobs injectable so the timeout behavior can be tested without adding five seconds
# to the suite.
_wait_for_holder_ready() {
  local marker="$1" ticks="${2:-100}" interval="${3:-0.05}" n=0
  while [ ! -e "$marker" ] && [ "$n" -lt "$ticks" ]; do
    sleep "$interval"
    n=$((n + 1))
  done
  [ -e "$marker" ]
}

@test "holder readiness times out and fails instead of waiting forever" {
  run _wait_for_holder_ready "$TEST_SKILL_DIR/never-ready" 2 0.01
  [ "$status" -ne 0 ]
}

@test "teardown reaper kills a detached process holding TEST_SKILL_DIR (#662)" {
  local hp; hp="$(_start_holder)"
  kill -0 "$hp"                       # holder is alive and holding run/
  _reap_test_skill_dir_procs         # THE FIX — a no-op reaper leaves it alive (mutation)
  refute kill -0 "$hp"               # reaper killed it, so run/ is free for the rm
}

@test "teardown reaper leaves a process that does NOT reference TEST_SKILL_DIR alone (scope safety)" {
  # The reaper must never reach a developer's live bridge or another test's process.
  # A `sleep` that names this test's mktemp dir in neither argv nor environment must
  # survive. `env -i`: started from this shell it would otherwise inherit HOME etc.
  # under TEST_SKILL_DIR, which is exactly what marks a process as this test's own.
  env -i PATH="$PATH" sleep 30 &
  local other=$!
  _reap_test_skill_dir_procs
  kill -0 "$other"                   # untouched
  kill "$other" 2>/dev/null || true
}

@test "teardown reaper is a no-op when nothing holds TEST_SKILL_DIR" {
  run _reap_test_skill_dir_procs
  [ "$status" -eq 0 ]
}

@test "teardown process scan does not report its own awk probe" {
  run _pids_referencing_dir "$TEST_SKILL_DIR"
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "teardown reaper fails when its bounded wait expires" {
  # Keep the process list non-empty while replacing the side effects with no-ops. The
  # 60-tick ceiling then runs quickly and this test proves timeout is not reported green.
  # The stubs live in a subshell so this test's own teardown runs the real reaper.
  _reap_with_stubs() (
    _pids_referencing_dir() { printf '%s\n' 999999; }
    _pid_references_dir() { return 0; }
    kill() { :; }
    sleep() { :; }
    _reap_test_skill_dir_procs
  )
  run _reap_with_stubs
  [ "$status" -ne 0 ]
}

@test "teardown reaper refuses to scan when TEST_SKILL_DIR is not a temp path (guard)" {
  # A mis-set TEST_SKILL_DIR must never turn the scan loose on a short/rooty prefix
  # (which would match — and kill — nearly every process).
  sleep 30 &
  local other=$!
  TEST_SKILL_DIR="/"    _reap_test_skill_dir_procs
  TEST_SKILL_DIR="/usr" _reap_test_skill_dir_procs
  kill -0 "$other"                   # nothing was scanned or killed for a rooty dir
  kill "$other" 2>/dev/null || true
}

@test "teardown reaper fails closed on a NON-temp TEST_SKILL_DIR for a degenerate TMPDIR: unset / empty / root (#662, co2 BLOCKING)" {
  # utildev measured that ubuntu-latest's `mktemp -d` uses /tmp with TMPDIR UNSET, so a
  # guard pattern assembled from $TMPDIR degenerates to ?* there and would turn this KILL
  # loose on CI Linux. Prove fail-closed: with a NON-temp TEST_SKILL_DIR and TMPDIR unset,
  # "", or "/", a probe whose argv carries that dir must SURVIVE. A bare `sleep` cannot
  # show this — the degenerate scan would find nothing to kill and pass vacuously — so the
  # probe gives the scan a real target, and its survival is what distinguishes refuse from
  # scan-and-kill. (Mutation: restore the old `"${TMPDIR:+${TMPDIR%/}/}"?*` guard and this
  # reds — the probe gets killed under the non-temp dir.)
  local marker="/agmsg-nontemp-probe-$$"
  local probe="$TEST_SKILL_DIR/scripts/probe.sh"
  mkdir -p "$(dirname "$probe")"
  printf '%s\n' '#!/usr/bin/env bash' 'while :; do sleep 0.1; done' > "$probe"
  chmod +x "$probe"
  local pp
  _spawn_probe() {
    # Orphaned (subshell) so it reparents to init like the real detached launcher. Its
    # argv carries $marker (so the reaper scoped to $marker would hit it if it degenerated)
    # AND $TEST_SKILL_DIR (the probe.sh path), so the real teardown reaps it afterwards.
    ( "$probe" "$marker" & printf '%s\n' "$!" > "$TEST_SKILL_DIR/probe.pid" )
    pp="$(cat "$TEST_SKILL_DIR/probe.pid")"
    kill -0 "$pp"   # running, so "survives" below is meaningful rather than a race
  }
  _spawn_probe; ( unset TMPDIR; TEST_SKILL_DIR="$marker" _reap_test_skill_dir_procs ); kill -0 "$pp"; kill "$pp" 2>/dev/null || true
  _spawn_probe; TMPDIR=""  TEST_SKILL_DIR="$marker" _reap_test_skill_dir_procs;         kill -0 "$pp"; kill "$pp" 2>/dev/null || true
  _spawn_probe; TMPDIR="/" TEST_SKILL_DIR="$marker" _reap_test_skill_dir_procs;         kill -0 "$pp"; kill "$pp" 2>/dev/null || true
}

# Start an orphan (reparented away from this shell, like a nohup+disown'd engine)
# running <cmd...>, and echo its pid. Its stdio and bats' fd 3 are closed so neither the
# caller nor bats waits on it.
_start_orphan() {
  ( "$@" </dev/null >/dev/null 2>&1 3>&- & printf '%s\n' "$!" > "$TEST_SKILL_DIR/orphan.pid" )
  cat "$TEST_SKILL_DIR/orphan.pid" >> "$BATS_TEST_TMPDIR/orphans.pids"
  cat "$TEST_SKILL_DIR/orphan.pid"
}

@test "teardown reaps an orphan that names TEST_SKILL_DIR only in its environment, even when the rm would succeed" {
  # The leak this exists for: a detached `while :; do sleep 1; done` engine (or its
  # `sleep`, or a fake app-server's python) whose argv does not name the test dir and
  # which does not stop `rm -rf` on Linux. It inherits HOME=$TEST_SKILL_DIR/home.
  _dir_ref_use_proc || skip "environment scan needs /proc (ps-argv fallback elsewhere)"
  local orphan; orphan="$(_start_orphan sleep 300)"
  kill -0 "$orphan"
  refute grep -qaF -- "$TEST_SKILL_DIR" "/proc/$orphan/cmdline"   # argv does not name it
  grep -qaF -- "$TEST_SKILL_DIR" "/proc/$orphan/environ"          # only the env does
  teardown_test_env                  # nothing holds the tree open, so the rm alone succeeds
  wait_for_pid_exit "$orphan"        # ...and the orphan was reaped anyway (mutation: rm-gated reaper)
  [ ! -d "$TEST_SKILL_DIR" ]
}

@test "teardown reaper does not touch a process whose environment names only a SIBLING of TEST_SKILL_DIR" {
  # Another test's mktemp dir can share TEST_SKILL_DIR as a string prefix only if its
  # name is longer; the match is path-bounded (<dir> or <dir>/...), so that process
  # survives. env -i so nothing of THIS test's environment comes along.
  _dir_ref_use_proc || skip "environment scan needs /proc (ps-argv fallback elsewhere)"
  local sibling="${TEST_SKILL_DIR}x" other
  other="$(_start_orphan env -i PATH="$PATH" HOME="$sibling/home" AGMSG_PROBE="$sibling" sleep 300)"
  kill -0 "$other"
  grep -qaF -- "$sibling" "/proc/$other/environ"
  _reap_test_skill_dir_procs
  kill -0 "$other"                   # untouched
  kill "$other" 2>/dev/null || true
}

# --- the path match is bounded on BOTH sides (review R1) ----------------------
# A process whose environment/argv names `/not-owned<dir>/...` is somebody else's: the
# match must not slide into the middle of another absolute path. Read-only checks on
# the two selectors (scan and pre-signal re-check); the probes are this test's own
# `env -i` children and are stopped by exact pid at the end.

# Probes are stopped by exact pid BEFORE the assertions, so a failing assertion cannot
# leave the foreign ones (which teardown would rightly not touch) running.
_rc() { "$@" >/dev/null 2>&1 && echo 0 || echo 1; }

# Argv probes: `_start_orphan "${ARGV_PROBE[@]}" <argv0>` carries <argv0> in its argv
# as ONE process -- bash execs `sleep` under that argv[0], so the pid that is checked
# is the pid that is stopped, with no child left behind (a `bash -c 'sleep 300; :'`
# probe left its sleep running -- review R3). env -i: nothing of this test's
# environment comes along. An array, not a function: _start_orphan's $! must be the
# probe itself, not a subshell running a function.
ARGV_PROBE=(env -i "PATH=$PATH" bash -c 'exec -a "$0" sleep 300')

@test "path match rejects a foreign path that merely CONTAINS TEST_SKILL_DIR (/not-owned<dir>/...), in scan and re-check" {
  _dir_ref_use_proc || skip "environment scan needs /proc"
  local foreign="/not-owned$TEST_SKILL_DIR" envp argp listed r_env r_arg
  envp="$(_start_orphan env -i PATH="$PATH" HOME="$foreign/home" sleep 300)"
  argp="$(_start_orphan "${ARGV_PROBE[@]}" "$foreign/x")"
  local alive_env alive_arg
  alive_env="$(_rc kill -0 "$envp")"; alive_arg="$(_rc kill -0 "$argp")"
  r_env="$(_rc _pid_references_dir "$envp" "$TEST_SKILL_DIR")"
  r_arg="$(_rc _pid_references_dir "$argp" "$TEST_SKILL_DIR")"
  listed="$(_pids_referencing_dir "$TEST_SKILL_DIR")"
  kill "$envp" "$argp" 2>/dev/null || true
  [ "$alive_env$alive_arg" = "00" ]     # the probes were really running
  [ "$r_env" = 1 ]
  [ "$r_arg" = 1 ]
  refute grep -qx -- "$envp" <<<"$listed"
  refute grep -qx -- "$argp" <<<"$listed"
}

@test "path match accepts <dir> itself and <dir>/... in argv and in the environment (positive control)" {
  _dir_ref_use_proc || skip "environment scan needs /proc"
  local envp argp exactp listed r
  envp="$(_start_orphan env -i PATH="$PATH" HOME="$TEST_SKILL_DIR/home" sleep 300)"
  exactp="$(_start_orphan env -i PATH="$PATH" PROBE_DIR="$TEST_SKILL_DIR" sleep 300)"
  argp="$(_start_orphan "${ARGV_PROBE[@]}" "$TEST_SKILL_DIR/x")"
  r="$(_rc _pid_references_dir "$envp" "$TEST_SKILL_DIR")$(_rc _pid_references_dir "$exactp" "$TEST_SKILL_DIR")$(_rc _pid_references_dir "$argp" "$TEST_SKILL_DIR")"
  listed="$(_pids_referencing_dir "$TEST_SKILL_DIR")"
  # The argv probe is the exec'd sleep itself (argv[0] = the path), not a parent of one.
  local argv0 kids
  argv0="$(tr '\0' '\n' < "/proc/$argp/cmdline" | head -n 1)"
  kids="$(cat "/proc/$argp/task/$argp/children" 2>/dev/null || true)"
  kill "$envp" "$exactp" "$argp" 2>/dev/null || true
  [ "$r" = "000" ]
  [ "$argv0" = "$TEST_SKILL_DIR/x" ]
  [ -z "${kids// /}" ]
  grep -qx -- "$envp" <<<"$listed"
  grep -qx -- "$exactp" <<<"$listed"
  grep -qx -- "$argp" <<<"$listed"
}

@test "ps fallback uses the same bounded match: <dir>/... in argv yes, /not-owned<dir>/... and <dir>x no" {
  # AGMSG_TEST_REAP_PS_ONLY forces the no-/proc (macOS) path on this host.
  local own foreign sibling envonly listed r
  own="$(_start_orphan "${ARGV_PROBE[@]}" "$TEST_SKILL_DIR/x")"
  foreign="$(_start_orphan "${ARGV_PROBE[@]}" "/not-owned$TEST_SKILL_DIR/x")"
  sibling="$(_start_orphan "${ARGV_PROBE[@]}" "${TEST_SKILL_DIR}x/y")"
  # Names the dir only in its environment, which ps cannot see: proves this run
  # really took the ps path (the /proc path would list it).
  envonly="$(_start_orphan env -i PATH="$PATH" HOME="$TEST_SKILL_DIR/home" sleep 300)"
  listed="$(AGMSG_TEST_REAP_PS_ONLY=1 _pids_referencing_dir "$TEST_SKILL_DIR")"
  r="$(AGMSG_TEST_REAP_PS_ONLY=1 _rc _pid_references_dir "$own" "$TEST_SKILL_DIR")"
  r="$r$(AGMSG_TEST_REAP_PS_ONLY=1 _rc _pid_references_dir "$foreign" "$TEST_SKILL_DIR")"
  r="$r$(AGMSG_TEST_REAP_PS_ONLY=1 _rc _pid_references_dir "$sibling" "$TEST_SKILL_DIR")"
  kill "$own" "$foreign" "$sibling" "$envonly" 2>/dev/null || true
  [ "$r" = "011" ]
  refute grep -qx -- "$envonly" <<<"$listed"
  grep -qx -- "$own" <<<"$listed"
  refute grep -qx -- "$foreign" <<<"$listed"
  refute grep -qx -- "$sibling" <<<"$listed"
}

# --- a pid read from a file is not trusted as is (review R2) -----------------
# kill_test_owned_pid backs the teardowns that read pidfiles / #1254 seat records.
# `kill` is replaced by a recorder in a subshell, so the negative cases send no
# real signal at all.

_owned_kill_would_signal() {   # <pid> -> prints WOULD_SIGNAL lines, sends nothing
  (
    kill() { printf 'WOULD_SIGNAL %s\n' "$*"; }
    wait_for_pid_exit() { return 0; }
    kill_test_owned_pid "$1"
  )
}

@test "kill_test_owned_pid never signals 0, 1, empty or a non-numeric value (kill 0 = whole process group)" {
  local v out
  for v in 0 1 "" abc -5 "12 34" 00; do
    out="$(_owned_kill_would_signal "$v")"
    [ -z "$out" ] || { echo "signalled for '$v': $out"; false; }
  done
}

@test "kill_test_owned_pid does not signal a live process that is not this test's" {
  local other out
  other="$(_start_orphan env -i PATH="$PATH" sleep 300)"
  kill -0 "$other"
  out="$(_owned_kill_would_signal "$other")"
  [ -z "$out" ]
  kill -0 "$other"
  kill "$other" 2>/dev/null || true
}

@test "kill_test_owned_pid stops a process that IS this test's (positive control)" {
  # The orphan names TEST_SKILL_DIR only in its environment (HOME), which only the
  # /proc path can see; the ps-argv path (macOS) correctly declines to signal it.
  _dir_ref_use_proc || skip "ownership by environment needs /proc (ps-argv fallback elsewhere)"
  local mine
  mine="$(_start_orphan sleep 300)"     # inherits HOME=$TEST_SKILL_DIR/home
  kill -0 "$mine"
  [ "$(_owned_kill_would_signal "$mine")" = "WOULD_SIGNAL $mine" ]
  kill_test_owned_pid "$mine"
  wait_for_pid_exit "$mine"
}
