#!/usr/bin/env python3
"""Read-only layered diagnosis for one Antigravity TUI seat.

`agy-tui status` answers "is there a supervisor for this role", and stops
there. Four things it cannot tell you, each of which has cost someone time:

  * WHICH reservation file it matched. `run/` accumulates two naming schemes
    (`read-reservation.<key>.json` and the legacy `antigravity-reservation.`),
    plus sidecars that outlive their reservation. When two match, `status`
    prints two contradictory lines and names neither file.
  * Whether the PTY CHILD is alive. `status` resolves the reservation pid,
    which is the SUPERVISOR. A supervisor whose child died keeps its
    reservation and reads as healthy; nothing in the CLI has a name for that.
  * Which phase the supervisor is in, so a stall has a location.
  * Whether the refusal you just hit means "none" or "several". `--action stop`
    prints one sentence for both (`len(live)!=1`), and the remedy differs.

Everything here is a read. No signals, no writes, no `ack`/`replay`/
`reset-guard`, and no `inbox.sh` -- that one is not merely a write, it marks
messages read, and a diagnosis that consumes the thing it is diagnosing is
worse than no diagnosis. The guard layer checks the hook is REGISTERED rather
than provoking it.

`--self-test` is the one writing mode and it writes exactly one thing: a
self-addressed marker message. It is refused unless the seat is idle and has
no unresolved batch, because a batch it created would make an existing
`uncertain` batch harder to resolve, not easier.

Exit codes follow codex-diag.sh, and the 1/2 split is the point:
  0 every layer MATCH (with --self-test: SCREEN_CONFIRMED)
  1 asked and the answer was wrong (MISMATCH)
  2 could not ask (UNKNOWN), or bad arguments
  3 PENDING -- self-test sent, receipt not observed yet
"""
import argparse, importlib.util, json, os, subprocess, sys, time, uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _load_supervisor():
    """Import the supervisor module for its process-identity primitives.

    Reusing `proc_start`/`process_still` rather than reimplementing them is
    deliberate: the whole value of those functions is the split between
    "that pid is gone" (FileNotFoundError) and "we could not find out"
    (StartTimeUnreadable), and a second implementation is exactly how the two
    get collapsed back together.
    """
    path = HERE / 'antigravity-tui-supervisor.py'
    spec = importlib.util.spec_from_file_location('agmsg_antigravity_supervisor', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SUP = _load_supervisor()
ROOT = SUP.ROOT
RUN = ROOT / 'run'


class Layer:
    """One diagnosed layer: a state, a headline, and optional remedy lines."""

    def __init__(self, name, state, headline, remedy=None, command=None, note=None):
        self.name = name
        self.state = state
        self.headline = headline
        self.remedy = remedy
        self.command = command
        self.note = note

    def render(self):
        out = [f'{self.name}: {self.state} {self.headline}'.rstrip()]
        if self.remedy:
            out.append(f'  {self.remedy}')
        if self.command:
            for line in self.command.splitlines():
                out.append(f'    {line}')
        if self.note:
            out.append(f'  {self.note}')
        return out


def run_cmd(argv, timeout=20, stdin_text=None):
    """Run a helper. Returns (rc, stdout, stderr); never raises.

    stdin is never inherited. A diagnosis runs from whatever terminal invoked it,
    and a helper that reads stdin -- `send.sh --body -` does exactly that -- would
    either consume the operator's keystrokes or block forever. Pass `stdin_text`
    to feed one; everything else gets /dev/null, which turns "the caller forgot"
    into an immediate, visible refusal instead of a hang.
    """
    try:
        if stdin_text is None:
            p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout,
                               stdin=subprocess.DEVNULL)
        else:
            p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout,
                               input=stdin_text)
        return p.returncode, p.stdout, p.stderr
    except (OSError, subprocess.SubprocessError) as exc:
        return None, '', str(exc)


def key_for(team, role):
    return f'{SUP.encode_component(team)}__{SUP.encode_component(role)}'


def scan_reservations(project, team, role):
    """Return (matches, problems, orphans).

    `matches` mirrors the scan in the supervisor's status/stop action so the
    diagnosis describes the same set those commands act on. `problems` carries
    files we could not read -- never silently skipped, because "could not ask"
    is a distinct answer. `orphans` are sidecars whose reservation is gone,
    which is what accumulates in `run/` and what nothing else reports.
    """
    matches, problems, orphans = [], [], []
    want_project = str(Path(project).absolute())
    files = sorted(RUN.glob('read-reservation.*.json')) + sorted(RUN.glob('antigravity-reservation.*.json'))
    for file in files:
        legacy = file.name.startswith('antigravity-reservation.')
        try:
            reservation = json.loads(file.read_text())
        except (OSError, ValueError) as exc:
            problems.append((file, f'unreadable: {exc}'))
            continue
        if reservation.get('type') != 'antigravity' and not (legacy and 'type' not in reservation):
            continue
        if reservation.get('kind') != 'tui-pty':
            continue
        state_path = reservation.get('state')
        if not state_path:
            problems.append((file, 'reservation has no state path'))
            continue
        try:
            state = json.loads(Path(state_path).read_text())
        except (OSError, ValueError) as exc:
            problems.append((file, f'state unreadable: {exc}'))
            continue
        if (state.get('project') != want_project or state.get('team') != team
                or state.get('role') != role):
            continue
        live, live_known = False, True
        try:
            live = SUP.process_still(int(reservation['pid']), reservation['start'])
        except SUP.StartTimeUnreadable as exc:
            live_known = False
            problems.append((file, f'process identity unreadable: {exc}'))
        except (KeyError, TypeError, ValueError) as exc:
            problems.append((file, f'malformed pid/start: {exc}'))
            continue
        matches.append({
            'file': file, 'legacy': legacy, 'reservation': reservation,
            'state': state, 'live': live, 'live_known': live_known,
        })

    for sidecar in sorted(RUN.glob('*.violations')):
        body = Path(str(sidecar)[: -len('.violations')])
        if not body.exists():
            orphans.append(sidecar)
    return matches, problems, orphans


def describe_reservation(entry):
    reservation = entry['reservation']
    scheme = 'legacy' if entry['legacy'] else 'current'
    live = 'unknown' if not entry['live_known'] else ('true' if entry['live'] else 'false')
    return (f'{entry["file"].name} scheme={scheme} '
            f'pid={reservation.get("pid")} live={live}')


def diagnose_seat(matches, problems, project, team, role):
    """L1: is there exactly one reservation for this seat, and is it current?"""
    quoted = f'--project {project} --team {team} --name {role}'
    if problems and not matches:
        return Layer('seat', 'UNKNOWN',
                     f'{len(problems)} reservation(s) could not be read',
                     'A reservation that cannot be read is not the same as one that is absent.',
                     None,
                     '; '.join(f'{f.name}: {why}' for f, why in problems))
    if not matches:
        return Layer('seat', 'MISMATCH', 'no reservation matches this project/team/role',
                     'Nothing holds this seat. Start a TUI monitor:',
                     f'agy-tui {quoted}')
    if len(matches) > 1:
        detail = '\n'.join(describe_reservation(m) for m in matches)
        return Layer('seat', 'MISMATCH', f'{len(matches)} reservations match this seat',
                     'Two reservations claim one seat; stop/resume refuse while this holds. '
                     'Identify the live one and retire the other:',
                     detail)
    entry = matches[0]
    if not entry['live_known']:
        return Layer('seat', 'UNKNOWN', describe_reservation(entry),
                     'The process table could not be read, so this reservation is neither '
                     'confirmed current nor confirmed stale.')
    if not entry['live']:
        return Layer('seat', 'MISMATCH', describe_reservation(entry),
                     'The reservation names a process that is gone. `agy-tui stop` reports '
                     '"not uniquely identified" here because zero live supervisors match, '
                     'not because several do. Start a new TUI monitor:',
                     f'agy-tui {quoted}')
    return Layer('seat', 'MATCH', describe_reservation(entry))


def diagnose_supervisor(entry):
    """L2: is the supervisor named by the reservation the process still there?"""
    if entry is None:
        return Layer('supervisor', 'UNKNOWN', 'no single reservation to resolve')
    reservation = entry['reservation']
    if not entry['live_known']:
        return Layer('supervisor', 'UNKNOWN',
                     f'pid={reservation.get("pid")} start token unreadable')
    if not entry['live']:
        return Layer('supervisor', 'MISMATCH',
                     f'pid={reservation.get("pid")} is not running')
    return Layer('supervisor', 'MATCH',
                 f'pid={reservation.get("pid")} start={reservation.get("start")}')


def diagnose_child(entry, project, team, role):
    """L3: the layer `status` does not have -- is the PTY child still there?

    A supervisor that outlived its child keeps its reservation, so every other
    view of this seat reads as healthy. This is the shape behind an
    `[Errno 5] Input/output error` exit: the PTY went away under a supervisor
    that was otherwise fine.
    """
    quoted = f'--project {project} --team {team} --name {role}'
    if entry is None:
        return Layer('child', 'UNKNOWN', 'no single reservation to resolve')
    state = entry['state']
    child_pid, child_start = state.get('childPid'), state.get('childStart')
    if child_pid is None or child_start is None:
        phase = state.get('supervisorPhase')
        return Layer('child', 'UNKNOWN',
                     f'state records no child yet (supervisorPhase={phase})')
    try:
        alive = SUP.process_still(int(child_pid), child_start)
    except SUP.StartTimeUnreadable as exc:
        return Layer('child', 'UNKNOWN', f'pid={child_pid} start token unreadable ({exc})')
    except (TypeError, ValueError) as exc:
        return Layer('child', 'UNKNOWN', f'pid={child_pid} malformed in state ({exc})')
    if not alive:
        if entry['live_known'] and entry['live']:
            return Layer('child', 'MISMATCH', f'pid={child_pid} is gone while the supervisor runs',
                         'The supervisor is alive but its agy child is not, so nothing renders '
                         'what gets injected. Stop it and start again:',
                         f'agy-tui stop {quoted}\nagy-tui {quoted}')
        return Layer('child', 'MISMATCH', f'pid={child_pid} is gone')
    return Layer('child', 'MATCH', f'pid={child_pid} start={child_start}')


def _paused_phase(state, headline):
    """A pause is not one flag, and the flags do not clear the same way.

    SIGUSR1 (`resume`) clears manual_resume and human_input in the supervisor
    loop and never touches durable_attention; only reset_guard() clears that,
    and it refuses while the supervisor holding the seat is alive. Advising
    `resume` for a durable_attention pause sends the operator down a path that
    reports success and changes nothing -- which is how this was found.
    """
    durable = bool(state.get('durableAttention'))
    human = bool(state.get('manualResumeRequired') or state.get('humanInputActive'))
    if not durable:
        return ('Delivery is held by a pause flag, so nothing reaches the TUI even though '
                'the phase looks idle. Clear it from the screen, or:',
                'agy-tui resume --project <project> --team <team> --name <role>',
                None)
    lead = ('Delivery is held by durable_attention, which `resume` does not clear: SIGUSR1 '
            'clears manual_resume and human_input only.')
    if human:
        lead += (' The other flags here would clear, so a resume reports success and leaves '
                 'delivery stopped.')
    return (lead + ' Only reset-guard clears durable_attention, and it refuses while this '
                   'supervisor is alive, so stop that first and start the monitor again:',
            'agy-tui stop --project <project> --team <team> --name <role>\n'
            'agy-tui reset-guard --project <project> --team <team> --name <role>\n'
            'agy-tui --project <project> --team <team> --name <role>',
            'reset-guard keeps the reservation and leaves messages unread; it refuses while '
            'a batch is unresolved.')


def diagnose_phase(entry, matches=()):
    """L4: where in the state machine this seat sits, and whether a batch blocks it.

    When the seat is ambiguous there is no single state to report -- but an
    unresolved batch is the thing that decides which recovery applies, and
    hiding it behind "no single reservation" is how it goes unnoticed. So the
    batch is surfaced from whichever matched state carries one.
    """
    if entry is None:
        held = [m for m in matches if (m['state'].get('batch') or {}).get('id')]
        if held:
            detail = '\n'.join(
                f'{m["file"].name}: batch={m["state"]["batch"].get("id")} '
                f'batch_phase={m["state"]["batch"].get("phase")} '
                f'messages={len(m["state"]["batch"].get("messages", []))}'
                for m in held)
            return Layer('phase', 'BLOCKED',
                         f'{len(held)} of {len(matches)} matched states hold a batch',
                         'An unresolved batch survives the ambiguity above and will not clear '
                         'by itself. This diagnosis does not run ack/replay/reset-guard:',
                         detail)
        return Layer('phase', 'UNKNOWN', 'no single reservation to resolve')
    state = entry['state']
    flags = (f'durable_attention={str(state.get("durableAttention", False)).lower()} '
             f'manual_resume={str(state.get("manualResumeRequired", False)).lower()} '
             f'human_input={str(state.get("humanInputActive", False)).lower()}')
    phase = state.get('supervisorPhase')
    batch = state.get('batch')
    paused = bool(state.get('durableAttention') or state.get('manualResumeRequired')
                  or state.get('humanInputActive'))
    if not batch:
        if phase == 'NEEDS_ATTENTION':
            # Same root cause as the pause below: fail() sets durable_attention
            # and this phase together. Reporting the mismatch without the way
            # out leaves the operator exactly where the old resume advice did.
            head = f'supervisor_phase={phase} batch=none {flags}'
            if state.get('durableAttention'):
                remedy, command, note = _paused_phase(state, head)
                return Layer('phase', 'MISMATCH', head, remedy, command, note)
            return Layer('phase', 'MISMATCH', head)
        if paused:
            # maybe_poll() returns early on any of these, so nothing is injected
            # while they hold. Healthy-looking phase, delivery stopped.
            head = f'supervisor_phase={phase} batch=none {flags}'
            remedy, command, note = _paused_phase(state, head)
            return Layer('phase', 'BLOCKED', head, remedy, command, note)
        return Layer('phase', 'MATCH', f'supervisor_phase={phase} batch=none {flags}')
    headline = (f'supervisor_phase={phase} batch={batch.get("id")} '
                f'batch_phase={batch.get("phase")} messages={len(batch.get("messages", []))} {flags}')
    if batch.get('phase') == 'uncertain' or phase == 'NEEDS_ATTENTION':
        return Layer('phase', 'BLOCKED', headline,
                     'An unresolved batch is held on purpose and will not clear by itself. '
                     'This diagnosis does not run ack/replay/reset-guard; decide from the '
                     'screen which one applies:',
                     'agy-tui status --project <project> --team <team> --name <role>')
    return Layer('phase', 'MATCH', headline)


def diagnose_guard(entry, project, orphans):
    """L5: is the read guard intact, and has it fired?

    Deliberately does NOT run `inbox.sh` to see it refused: that call marks
    messages read when it is not blocked, and a diagnosis must not consume the
    mailbox it reports on. Presence of the registered hook is the evidence.
    """
    notes = []
    hook_state = 'unknown'
    hooks_json = Path(project) / '.agents' / 'hooks.json'
    if hooks_json.exists():
        try:
            raw = hooks_json.read_text()
            hook_state = 'registered' if 'block-agmsg-inbox' in raw else 'absent'
        except OSError as exc:
            notes.append(f'hooks.json unreadable: {exc}')
    else:
        hook_state = 'no-hooks-json'

    violations_state = 'unknown'
    if entry is not None:
        # The supervisor hangs its violations sidecar off the CURRENT reservation
        # path, so look there first even when the match came from the legacy file.
        key = key_for(entry['state'].get('team'), entry['state'].get('role'))
        violations = RUN / f'read-reservation.{key}.json.violations'
        if not violations.exists():
            violations = Path(str(entry['file']) + '.violations')
        if violations.exists():
            try:
                violations_state = 'empty' if violations.read_text().strip() == '' else 'non-empty'
            except OSError as exc:
                notes.append(f'violations unreadable: {exc}')
        else:
            violations_state = 'absent'

    headline = f'inbox_hook={hook_state} violations={violations_state}'
    if orphans:
        headline += f' orphan_sidecars={len(orphans)}'
        notes.append('orphan sidecars (reservation already gone): '
                     + ', '.join(o.name for o in orphans))
    if violations_state == 'non-empty':
        return Layer('guard', 'MISMATCH', headline,
                     'A plain inbox read was attempted against a seat the TUI bridge owns. '
                     'The supervisor refuses to start until this is cleared:',
                     'agy-tui reset-guard --project <project> --team <team> --name <role>',
                     '; '.join(notes) if notes else None)
    if hook_state in ('absent', 'no-hooks-json'):
        return Layer('guard', 'UNKNOWN', headline,
                     'The inbox guard hook is not registered for this project, so nothing '
                     'stops a plain inbox read from consuming bridge-owned messages.',
                     None, '; '.join(notes) if notes else None)
    if hook_state == 'unknown' or violations_state == 'unknown':
        # Half-read is not intact. Saying MATCH here would claim the guard was
        # checked when one of its two halves never answered.
        return Layer('guard', 'UNKNOWN', headline,
                     'Part of the guard could not be read, so it is not established as intact.',
                     None, '; '.join(notes) if notes else None)
    return Layer('guard', 'MATCH', headline, None, None,
                 '; '.join(notes) if notes else None)


def diagnose_delivery(project):
    rc, out, err = run_cmd(['bash', str(ROOT / 'scripts' / 'delivery.sh'), 'status', 'antigravity', project])
    if rc is None or rc != 0:
        return Layer('delivery', 'UNKNOWN', f'delivery.sh status failed ({err.strip() or rc})')
    mode = terminal = ''
    runtimes = []
    for line in out.splitlines():
        line = line.strip()
        if line.startswith('mode:'):
            mode = line.split(':', 1)[1].strip()
        elif line.startswith('terminal:'):
            terminal = line.split(':', 1)[1].strip()
        elif line.startswith('runtime:'):
            runtimes.append(line.split(':', 1)[1].strip())
    if not mode:
        return Layer('delivery', 'UNKNOWN', 'delivery.sh status printed no mode line')
    headline = f'mode={mode} runtimes={len(runtimes)}'
    if terminal:
        headline += f' terminal={terminal}'
    if mode == 'off':
        return Layer('delivery', 'MISMATCH', headline,
                     'Delivery is off for this project, so nothing is routed to this seat:',
                     'delivery.sh set monitor antigravity <project>')
    return Layer('delivery', 'MATCH', headline)


def diagnose_placement():
    rc, out, err = run_cmd(['bash', str(ROOT / 'scripts' / 'where.sh')])
    if rc is None:
        return Layer('placement', 'UNKNOWN', f'where.sh could not run ({err.strip()})')
    text = ' '.join(out.split())
    if rc != 0:
        # A non-zero where.sh has not told us where this session sits. Reading its
        # partial stdout as a clean placement is the false negative this layer
        # exists to avoid.
        return Layer('placement', 'UNKNOWN', f'where.sh exited {rc} {text}'.rstrip(),
                     'Placement could not be determined; this is not the same as having no pane.')
    if not text:
        return Layer('placement', 'UNKNOWN', 'where.sh printed nothing',
                     'Placement could not be determined; this is not the same as having no pane.')
    if 'resolved=false' in text:
        return Layer('placement', 'UNKNOWN', text,
                     'Placement could not be determined; this is not the same as having no pane.')
    return Layer('placement', 'MATCH', text)


def diagnose_engine(team):
    rc, out, err = run_cmd(['bash', str(ROOT / 'scripts' / 'remote.sh'), 'status', team])
    engine_line = ''
    for line in out.splitlines():
        # `<team>\tconnected (engine running, pid N) since ...`; continuation
        # lines are indented, so the team row is the one that is not.
        if line.startswith(team + '\t'):
            engine_line = line.split('\t', 1)[1].strip()
            break
    # `systemctl is-active` answers 3 for an inactive unit, so a non-zero rc is
    # still an answer. No systemctl at all (rc is None -- Darwin, or a container
    # without it) is not: we then know nothing about who supervises this engine,
    # and must not name a unit to restart.
    urc, uout, _ = run_cmd(['systemctl', '--user', 'is-active', f'agmsg-remote-sync-{team}.service'])
    unit_known = urc is not None and uout.strip() != ''
    unit = uout.strip() if unit_known else 'unknown'
    if rc is None or rc != 0 or not engine_line:
        detail = (err or out).strip().splitlines()
        why = detail[0][:120] if detail else f'rc={rc}'
        return Layer('engine', 'UNKNOWN',
                     f'unit={unit} remote.sh status gave no row for this team ({why})')
    headline = f'unit={unit} {engine_line}'
    if not unit_known:
        return Layer('engine', 'UNKNOWN', headline,
                     'remote.sh reported an engine, but this host could not be asked whether a '
                     'systemd unit supervises it, so neither a restart nor sync start is safe '
                     'to prescribe from here.')
    if unit != 'active':
        return Layer('engine', 'MISMATCH', headline,
                     'The sync engine unit is not active, so messages from other machines do '
                     'not arrive. systemd owns it here, so restart the unit, not sync start:',
                     f'systemctl --user restart agmsg-remote-sync-{team}.service')
    return Layer('engine', 'MATCH', headline, None, None,
                 'An engine line proves local sync, not that any message reached a reader.')


def diagnose_history(team, role):
    rc, out, err = run_cmd(['bash', str(ROOT / 'scripts' / 'history.sh'), team, role])
    if rc is None or rc != 0:
        return Layer('history', 'UNKNOWN', f'history.sh failed ({err.strip() or rc})')
    lines = [x for x in out.splitlines() if x.strip()]
    if len(lines) == 1 and 'No message history' in lines[0]:
        lines = []
    latest = lines[-1].strip()[:110] if lines else 'none'
    return Layer('history', 'MATCH', f'lines={len(lines)} latest={latest}', None, None,
                 'Stored in the database is not the same as rendered on the TUI.')


# --------------------------------------------------------------------------
# self-test

SELF_TEST_TTL = 120


def self_test_path(diagnosis_id):
    return RUN / f'antigravity-self-test.{diagnosis_id}.json'


def self_test_refusal(layers, entry):
    """Why we must not send. Ordered so the most specific reason wins."""
    by_name = {layer.name: layer for layer in layers}
    for name in ('seat', 'supervisor', 'child'):
        if by_name[name].state != 'MATCH':
            return f'no-live-tui ({name}={by_name[name].state})'
    state = entry['state']
    if state.get('batch'):
        return 'unresolved-batch'
    if state.get('durableAttention') or state.get('manualResumeRequired') or state.get('humanInputActive'):
        return 'paused'
    for existing in RUN.glob('antigravity-self-test.*.json'):
        try:
            record = json.loads(existing.read_text())
        except (OSError, ValueError):
            continue
        if (record.get('team') == state.get('team') and record.get('role') == state.get('role')
                and record.get('state') == 'SENT' and time.time() < record.get('expires_epoch', 0)):
            return f'in-flight ({record.get("diagnosis_id")})'
    return None


def watch_for_receipt(entry, message_id, deadline):
    """Wait for the supervisor to take the marker and clear it.

    The batch clearing is what we are after: `ack()` is the only path that sets
    batch back to None, and it only runs once the receipt line has been found
    on the rendered screen. So the transition is the proof -- we do not have to
    inspect the screen ourselves, and we must not ask the agent to vouch for it.
    """
    state_file = Path(entry['reservation']['state'])
    seen_batch = None
    while time.time() < deadline:
        try:
            state = json.loads(state_file.read_text())
        except (OSError, ValueError):
            time.sleep(1)
            continue
        batch = state.get('batch')
        if batch:
            ids = [m.get('id') for m in batch.get('messages', [])]
            if message_id in ids:
                seen_batch = batch.get('id')
            if batch.get('phase') == 'uncertain':
                return 'MISMATCH', f'batch {batch.get("id")} went uncertain'
        elif seen_batch:
            return 'SCREEN_CONFIRMED', f'batch {seen_batch} acked'
        if state.get('supervisorPhase') == 'NEEDS_ATTENTION':
            return 'MISMATCH', 'supervisor entered NEEDS_ATTENTION'
        time.sleep(1)
    return 'PENDING', 'receipt not observed before the deadline'


def do_self_test(entry, layers, project, team, role):
    reason = self_test_refusal(layers, entry)
    if reason:
        print(f'self-test: UNKNOWN reason={reason}')
        print('  Nothing was sent. A self-test must not add a batch to a seat that is '
              'paused or already holding one.')
        return 2
    diagnosis_id = uuid.uuid4().hex
    nonce = uuid.uuid4().hex
    body = (f'AGMSG-SELF-TEST {diagnosis_id} nonce={nonce}\n'
            'Sent by agy-tui diagnose --self-test to confirm the supervisor renders a '
            'receipt on this TUI. No reply is needed.')
    rc, out, err = run_cmd(['bash', str(ROOT / 'scripts' / 'send.sh'), team, role, role,
                            '--body', '-', '--print-id'], timeout=30, stdin_text=body)
    if rc is None or rc != 0:
        print(f'self-test: UNKNOWN reason=send-failed detail={(err or out).strip()[:200]}')
        return 2
    message_id = ''
    for line in out.splitlines():
        if line.startswith('message_id='):
            message_id = line.split('=', 1)[1].strip()
    if not message_id:
        print('self-test: UNKNOWN reason=no-message-id')
        return 2
    expires = time.time() + SELF_TEST_TTL
    SUP.atomic(self_test_path(diagnosis_id), {
        'schemaVersion': 1, 'diagnosis_id': diagnosis_id, 'team': team, 'role': role,
        'project': str(Path(project).absolute()), 'message_id': message_id,
        'state': 'SENT', 'expires_epoch': expires,
    })
    verdict, detail = watch_for_receipt(entry, message_id, expires)
    record = json.loads(self_test_path(diagnosis_id).read_text())
    record['state'] = verdict
    record['detail'] = detail
    SUP.atomic(self_test_path(diagnosis_id), record)
    print(f'self-test: {verdict} diagnosis_id={diagnosis_id} message_id={message_id} ({detail})')
    if verdict == 'SCREEN_CONFIRMED':
        print('  tui-visible: RENDERED_AND_OBSERVED_BY_SUPERVISOR -- the receipt line was found '
              'on the screen model, which does not establish that a person was looking at it.')
        return 0
    if verdict == 'PENDING':
        print(f'  Re-check later without sending anything else:')
        print(f'    agy-tui diagnose --status {diagnosis_id}')
        return 3
    return 1


def do_status(diagnosis_id):
    path = self_test_path(diagnosis_id)
    if not path.exists():
        print(f'self-test: UNKNOWN diagnosis_id={diagnosis_id} reason=missing-record')
        return 2
    try:
        record = json.loads(path.read_text())
    except (OSError, ValueError) as exc:
        print(f'self-test: UNKNOWN diagnosis_id={diagnosis_id} reason=unreadable-record ({exc})')
        return 2
    state = record.get('state')
    if state == 'SENT' and time.time() > record.get('expires_epoch', 0):
        state = 'EXPIRED'
    print(f'self-test: {state} diagnosis_id={diagnosis_id} message_id={record.get("message_id")}')
    if state == 'SCREEN_CONFIRMED':
        return 0
    if state in ('MISMATCH', 'EXPIRED'):
        return 1
    if state == 'SENT':
        return 3
    return 2


def main():
    p = argparse.ArgumentParser(add_help=True)
    p.add_argument('project')
    p.add_argument('team')
    p.add_argument('role')
    p.add_argument('--self-test', action='store_true')
    p.add_argument('--status', dest='status_id')
    a = p.parse_args()

    if a.status_id:
        return do_status(a.status_id)

    matches, problems, orphans = scan_reservations(a.project, a.team, a.role)
    entry = matches[0] if len(matches) == 1 else None

    layers = [
        diagnose_seat(matches, problems, a.project, a.team, a.role),
        diagnose_supervisor(entry),
        diagnose_child(entry, a.project, a.team, a.role),
        diagnose_phase(entry, matches),
        diagnose_guard(entry, a.project, orphans),
        diagnose_delivery(a.project),
        diagnose_placement(),
        diagnose_engine(a.team),
        diagnose_history(a.team, a.role),
    ]

    states = [layer.state for layer in layers]
    if 'MISMATCH' in states:
        overall = 'MISMATCH'
        code = 1
    elif 'BLOCKED' in states:
        overall = 'BLOCKED'
        code = 1
    elif 'UNKNOWN' in states:
        overall = 'UNKNOWN'
        code = 2
    else:
        overall = 'MATCH'
        code = 0

    print(f'agy diagnosis: {overall} team={a.team} role={a.role}')
    for layer in layers:
        for line in layer.render():
            print(line)

    if a.self_test:
        return do_self_test(entry, layers, a.project, a.team, a.role)
    return code


if __name__ == '__main__':
    sys.exit(main())
