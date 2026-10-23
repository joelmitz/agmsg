#!/usr/bin/env bash
set -euo pipefail

# agmsg Antigravity TUI launcher shim
HERE="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(cd "$HERE/../../../.." && pwd)"
PROJECT="${AGMSG_ANTIGRAVITY_PROJECT:-$(pwd)}"
TEAM="${AGMSG_ANTIGRAVITY_TEAM:-}"
ROLE="${AGMSG_ANTIGRAVITY_ROLE:-}"
AGY="${AGMSG_ANTIGRAVITY_BIN:-}"

usage() {
  printf '%s\n' 'Usage: agy-tui [status|diagnose|stop|resume|reset-guard|ack|replay] [--project <path>] [--team <team>] [--name <role>] [--agy <path>] [-- agy options...]'
  printf '%s\n' \
    '  diagnose     read seat/supervisor/child/phase/guard/delivery/engine in one pass (read-only by default)' \
    '  ack          mark saved messages read only after verifying the same batch was received and replied to on screen' \
    '  replay       resend the unresolved saved batch to agy without marking messages read' \
    '  reset-guard  clear a regular-inbox violation without marking messages read'
}

ACTION=""
case "${1:-}" in
  status|diagnose|stop|resume|reset-guard|ack|replay) ACTION="$1"; shift ;;
esac

# PASSTHROUGH stays empty (and SAW_DASHDASH false) unless the caller writes a
# literal --. That is the only thing that opens pass-through to agy -- an
# unrecognized flag before it is a mistake to report, not a signal to start
# forwarding blind (a typo like --tema would otherwise launch agy silently
# carrying it, instead of failing here where it is obvious).
#
# --batch/--confirm-id are not agy-tui's own flags either, but they ARE
# supervisor flags (ack/replay recovery) that the shim has always had to let
# through -- collected into MONITOR_EXTRA, not PASSTHROUGH, so they land
# before -- and reach the supervisor's own argparse rather than agy.
PASSTHROUGH=()
SAW_DASHDASH=0
MONITOR_EXTRA=()
# diagnose's own flags (fork): collected here so the strict parse above still
# refuses anything else, and handed only to the read-only diagnose entry point.
DIAG_EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="${2:?--project requires a value}"; shift 2 ;;
    --team) TEAM="${2:?--team requires a value}"; shift 2 ;;
    --name) ROLE="${2:?--name requires a value}"; shift 2 ;;
    --agy) AGY="${2:?--agy requires a value}"; shift 2 ;;
    --batch) MONITOR_EXTRA+=(--batch "${2:?--batch requires a value}"); shift 2 ;;
    --confirm-id) MONITOR_EXTRA+=(--confirm-id "${2:?--confirm-id requires a value}"); shift 2 ;;
    --self-test) DIAG_EXTRA+=(--self-test); shift ;;
    --status) DIAG_EXTRA+=(--status "${2:?--status requires a value}"); shift 2 ;;
    -h|--help) usage; exit 0 ;;
    --) shift; SAW_DASHDASH=1; PASSTHROUGH=("$@"); break ;;
    *)
      printf 'agy-tui: unknown option %s -- use -- to pass options through to agy, for example: -- --dangerously-skip-permissions\n' "$1" >&2
      exit 1
      ;;
  esac
done

if [ -z "$TEAM" ] && [ -z "$ROLE" ]; then
  identities="$("$SKILL_DIR/scripts/identities.sh" "$PROJECT" antigravity 2>/dev/null || true)"
  identity_count="$(printf '%s\n' "$identities" | sed '/^$/d' | wc -l | tr -d ' ')"
  if [ "$identity_count" -eq 1 ]; then
    IFS=$'\t' read -r TEAM ROLE <<< "$identities"
  elif [ "$identity_count" -gt 1 ]; then
    printf 'agy-tui: project has multiple Antigravity identities; specify --team and --name.\n' >&2
    printf '%s\n' "$identities" | sed 's/^/  /' >&2
    exit 1
  else
    printf 'agy-tui: project does not have exactly one registered Antigravity identity; join with /agmsg or specify --team and --name.\n' >&2
    exit 1
  fi
fi

if [ -z "$TEAM" ] || [ -z "$ROLE" ]; then
  printf 'agy-tui: specify both --team and --name.\n' >&2
  exit 1
fi

if [ "$ACTION" = diagnose ]; then
  # Read-only, and it never launches agy -- so it must not refuse when the
  # binary is absent. Dispatched before the monitor path for the same reason
  # the shim lives outside the supervisor's argparse: state-changing actions
  # and this one do not share a route.
  exec bash "$HERE/antigravity-diagnose.sh" "$PROJECT" "$TEAM" "$ROLE" ${DIAG_EXTRA[@]:+"${DIAG_EXTRA[@]}"}
fi
if [ "${#DIAG_EXTRA[@]}" -gt 0 ]; then
  printf 'agy-tui: --self-test and --status are diagnose options\n' >&2
  exit 1
fi

if [ -z "$ACTION" ]; then
  if [ -z "$AGY" ]; then
    AGY="$(command -v agy || true)"
  fi
  if [ -z "$AGY" ] || [ ! -x "$AGY" ]; then
    printf 'agy-tui: agy is not on PATH; install agy or specify --agy <path>.\n' >&2
    exit 1
  fi
elif [ -z "$AGY" ]; then
  AGY="agy"
fi

monitor_args=(
  --project "$PROJECT"
  --team "$TEAM"
  --name "$ROLE"
  --agy "$AGY"
)
# The ${arr[@]:+...} guard, not a bare "${arr[@]}", because bash 3.2 (macOS's
# /bin/bash, what CI actually runs) treats expanding an array with zero
# elements under `set -u` as an unbound-variable error, even when the array
# was assigned empty rather than never assigned at all.
monitor_args+=(${MONITOR_EXTRA[@]:+"${MONITOR_EXTRA[@]}"})
if [ "$SAW_DASHDASH" -eq 1 ]; then
  monitor_args+=(--)
  monitor_args+=(${PASSTHROUGH[@]:+"${PASSTHROUGH[@]}"})
fi
if [ -n "$ACTION" ]; then
  exec bash "$HERE/antigravity-tui-monitor.sh" "$ACTION" "${monitor_args[@]}"
fi
exec bash "$HERE/antigravity-tui-monitor.sh" "${monitor_args[@]}"
