import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

const repo = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const supervisorSrc = path.join(repo, 'scripts/drivers/types/antigravity/antigravity-tui-supervisor.py');

// A pid is not an identity -- the supervisor pairs it with the start token from
// the process table, and so must every fixture here. Reading the token through
// the supervisor's own proc_start keeps the fixtures honest: a test that minted
// its own token would pass while the real comparison failed.
function procStart(pid) {
  const result = spawnSync('python3', ['-c', `
import importlib.util, sys
spec = importlib.util.spec_from_file_location('sup', ${JSON.stringify(supervisorSrc)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(m.proc_start(int(sys.argv[1])))
`, String(pid)], { encoding: 'utf8', env: { ...process.env, PYTHONPYCACHEPREFIX: '/tmp/agmsg-pycache' } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function makeInstall() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agmsg-diag-'));
  const install = path.join(dir, 'install');
  const project = path.join(dir, 'project');
  fs.mkdirSync(install, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.cpSync(path.join(repo, 'scripts'), path.join(install, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(install, 'run'), { recursive: true, mode: 0o700 });
  return { dir, install, project };
}

function writeSeat(install, project, { team, role, pid, start, childPid, childStart, batch, phase = 'WAITING_FOR_IDLE', key, legacy = false, flags = {} }) {
  const seatKey = key || `${team}__${role}`;
  const statePath = path.join(install, 'run', `antigravity-tui-pty.${seatKey}.state.json`);
  const state = {
    schemaVersion: 2, project: fs.realpathSync(project), team, role,
    supervisorPhase: phase, manualResumeRequired: false, humanInputActive: false,
    humanInputSawNonIdle: false, durableAttention: false, batch: batch || null, ...flags,
  };
  if (childPid !== undefined) { state.childPid = childPid; state.childStart = childStart; }
  fs.writeFileSync(statePath, JSON.stringify(state));
  const name = legacy ? `antigravity-reservation.${seatKey}.json` : `read-reservation.${seatKey}.json`;
  const reservation = { kind: 'tui-pty', pid, start, state: statePath, owner: 'fixture' };
  if (!legacy) reservation.type = 'antigravity';
  fs.writeFileSync(path.join(install, 'run', name), JSON.stringify(reservation));
  return { statePath, reservationPath: path.join(install, 'run', name) };
}

function diagnose(install, project, team, role, extra = [], env = {}) {
  return spawnSync('bash', [
    path.join(install, 'scripts/drivers/types/antigravity/antigravity-diagnose.sh'),
    project, team, role, ...extra,
  ], { encoding: 'utf8', env: { ...process.env, PYTHONPYCACHEPREFIX: '/tmp/agmsg-pycache', ...env } });
}

// Replace a helper the diagnosis shells out to. The install is a copy, so a stub
// here exercises the real call path -- argv, rc and stdout -- without touching
// anything outside the fixture.
function stubHelper(install, relPath, body) {
  const target = path.join(install, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body, { mode: 0o755 });
  return target;
}

// A PATH whose first entry shadows one command. Used for `systemctl`, which the
// engine layer resolves through PATH rather than an absolute path.
function pathWithShim(dir, name, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), body, { mode: 0o755 });
  return `${dir}:${process.env.PATH}`;
}

// A process we can point a reservation at and then take away, so "gone" is a
// fact about a pid we really owned rather than a number we hoped was free.
function spawnHolder() {
  const child = spawn('sleep', ['120'], { stdio: 'ignore' });
  const start = procStart(child.pid);
  return { pid: child.pid, start, kill: () => { try { child.kill('SIGKILL'); } catch {} } };
}

async function reap(holder) {
  holder.kill();
  for (let i = 0; i < 100; i++) {
    const probe = spawnSync('kill', ['-0', String(holder.pid)], { stdio: 'ignore' });
    if (probe.status !== 0) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('stale reservation: names the file and says zero live matched, not "several"', async () => {
  const { install, project } = makeInstall();
  const holder = spawnHolder();
  writeSeat(install, project, { team: 'demo', role: 'agy', pid: holder.pid, start: holder.start });
  await reap(holder);
  const result = diagnose(install, project, 'demo', 'agy');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^seat: MISMATCH read-reservation\.demo__agy\.json/m);
  assert.match(result.stdout, /zero live supervisors match, not because several do/);
});

test('supervisor alive, child gone: the case agy-tui status cannot express', async () => {
  const { install, project } = makeInstall();
  const supervisor = spawnHolder();
  const child = spawnHolder();
  writeSeat(install, project, {
    team: 'demo', role: 'agy', pid: supervisor.pid, start: supervisor.start,
    childPid: child.pid, childStart: child.start,
  });
  await reap(child);
  try {
    const result = diagnose(install, project, 'demo', 'agy');
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /^supervisor: MATCH /m);
    assert.match(result.stdout, /^child: MISMATCH pid=\d+ is gone while the supervisor runs/m);
    assert.match(result.stdout, /agy-tui stop --project/);
  } finally {
    supervisor.kill();
  }
});

test('two reservations for one seat are both named', async () => {
  const { install, project } = makeInstall();
  const a = spawnHolder();
  const b = spawnHolder();
  writeSeat(install, project, { team: 'demo', role: 'agy', pid: a.pid, start: a.start });
  writeSeat(install, project, { team: 'demo', role: 'agy', pid: b.pid, start: b.start, legacy: true });
  await reap(a);
  await reap(b);
  const result = diagnose(install, project, 'demo', 'agy');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^seat: MISMATCH 2 reservations match this seat/m);
  assert.match(result.stdout, /read-reservation\.demo__agy\.json scheme=current/);
  assert.match(result.stdout, /antigravity-reservation\.demo__agy\.json scheme=legacy/);
});

test('an unresolved batch is surfaced even when the seat is ambiguous', async () => {
  const { install, project } = makeInstall();
  const a = spawnHolder();
  const b = spawnHolder();
  writeSeat(install, project, { team: 'demo', role: 'agy', pid: a.pid, start: a.start });
  // The leftovers that actually accumulate are keyed by a session uuid rather
  // than team__role, so they carry their OWN state file -- which is how one of
  // two matching reservations can hold a batch while the other does not.
  writeSeat(install, project, {
    team: 'demo', role: 'agy', pid: b.pid, start: b.start, legacy: true,
    key: '019ffb5b-0000-7000-8000-000000000000__01a062ce-0000-7000-8000-000000000000',
    batch: { id: 'batch-x', phase: 'uncertain', messages: [{ id: 'm1', from: 'codex', at: 'now' }] },
  });
  await reap(a);
  await reap(b);
  const result = diagnose(install, project, 'demo', 'agy');
  assert.match(result.stdout, /^phase: BLOCKED 1 of 2 matched states hold a batch/m);
  assert.match(result.stdout, /batch=batch-x batch_phase=uncertain/);
  assert.match(result.stdout, /does not run ack\/replay\/reset-guard/);
});

test('no reservation at all is a different answer from an unreadable one', () => {
  const { install, project } = makeInstall();
  const empty = diagnose(install, project, 'demo', 'agy');
  assert.equal(empty.status, 1, empty.stdout + empty.stderr);
  assert.match(empty.stdout, /^seat: MISMATCH no reservation matches/m);

  fs.writeFileSync(path.join(install, 'run', 'read-reservation.demo__agy.json'), '{ not json');
  const broken = diagnose(install, project, 'demo', 'agy');
  assert.equal(broken.status, 2, broken.stdout + broken.stderr);
  assert.match(broken.stdout, /^seat: UNKNOWN 1 reservation\(s\) could not be read/m);
});

test('a diagnosis leaves run/ byte-for-byte as it found it', async () => {
  const { install, project } = makeInstall();
  const holder = spawnHolder();
  writeSeat(install, project, {
    team: 'demo', role: 'agy', pid: holder.pid, start: holder.start,
    batch: { id: 'batch-y', phase: 'uncertain', messages: [{ id: 'm1', from: 'codex', at: 'now' }] },
  });
  const runDir = path.join(install, 'run');
  const snapshot = () => fs.readdirSync(runDir).sort().map((name) => {
    const file = path.join(runDir, name);
    return `${name}:${fs.statSync(file).mtimeMs}:${fs.readFileSync(file).toString('base64')}`;
  }).join('\n');
  const before = snapshot();
  try {
    diagnose(install, project, 'demo', 'agy');
    assert.equal(snapshot(), before);
  } finally {
    holder.kill();
  }
});

test('--self-test refuses an unresolved batch and sends nothing', async () => {
  const { install, project } = makeInstall();
  const holder = spawnHolder();
  const childProc = spawnHolder();
  writeSeat(install, project, {
    team: 'demo', role: 'agy', pid: holder.pid, start: holder.start,
    childPid: childProc.pid, childStart: childProc.start,
    batch: { id: 'batch-z', phase: 'prepared', messages: [{ id: 'm1', from: 'codex', at: 'now' }] },
  });
  const runDir = path.join(install, 'run');
  const before = fs.readdirSync(runDir).sort().join(',');
  try {
    const result = diagnose(install, project, 'demo', 'agy', ['--self-test']);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /^self-test: UNKNOWN reason=unresolved-batch/m);
    assert.match(result.stdout, /Nothing was sent/);
    assert.equal(fs.readdirSync(runDir).sort().join(','), before);
  } finally {
    holder.kill();
    childProc.kill();
  }
});

test('a self-test on a healthy seat sends the body and confirms the receipt', async () => {
  // The success path of --self-test had never been executed: run_cmd built the
  // body but never handed it to `send.sh --body -`, which reads stdin. The
  // message was therefore empty (refused) or the call blocked on the caller's
  // terminal. This drives the real send and the real state transition.
  const { dir, install, project } = makeInstall();
  const holder = spawnHolder();
  const childProc = spawnHolder();
  const env = {
    AGMSG_STORAGE_DRIVER: 'sqlite',
    AGMSG_STORAGE_PATH: path.join(install, 'db'),
    AGMSG_CONFIG: path.join(dir, 'config.json'),
    PYTHONPYCACHEPREFIX: '/tmp/agmsg-pycache',
  };
  const join = spawnSync('bash', [path.join(install, 'scripts/join.sh'), 'demo', 'agy', 'antigravity', project],
    { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(join.status, 0, join.stderr + join.stdout);

  const { statePath } = writeSeat(install, project, {
    team: 'demo', role: 'agy', pid: holder.pid, start: holder.start,
    childPid: childProc.pid, childStart: childProc.start,
  });
  const runDir = path.join(install, 'run');

  const proc = spawn('bash', [
    path.join(install, 'scripts/drivers/types/antigravity/antigravity-diagnose.sh'),
    project, 'demo', 'agy', '--self-test',
  ], { encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  proc.stdout.on('data', (d) => { stdout += d; });
  proc.stderr.on('data', (d) => { stdout += d; });

  try {
    // The record lands only after send.sh returned a message_id, so its presence
    // is itself the proof that the body reached send.sh.
    let record = null;
    for (let i = 0; i < 300 && !record; i++) {
      const hit = fs.readdirSync(runDir).find((f) => f.startsWith('antigravity-self-test.'));
      if (hit) record = JSON.parse(fs.readFileSync(path.join(runDir, hit), 'utf8'));
      else await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(record, `no self-test record was written; output so far: ${stdout}`);
    assert.match(record.message_id, /\S/);

    // Stand in for the supervisor: the message becomes a batch, then the batch
    // clears -- which is what ack() does once the receipt line renders.
    const base = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    base.batch = { id: 'batch-live', phase: 'prepared', messages: [{ id: record.message_id, from: 'agy', at: 'now' }] };
    fs.writeFileSync(statePath, JSON.stringify(base));
    await new Promise((r) => setTimeout(r, 1200));
    base.batch = null;
    fs.writeFileSync(statePath, JSON.stringify(base));

    const status = await new Promise((r) => proc.on('close', r));
    assert.equal(status, 0, stdout);
    assert.match(stdout, /^self-test: SCREEN_CONFIRMED /m);
    assert.match(stdout, new RegExp(`message_id=${record.message_id}`));
    assert.match(stdout, /tui-visible: RENDERED_AND_OBSERVED_BY_SUPERVISOR/);
  } finally {
    try { proc.kill('SIGKILL'); } catch {}
    holder.kill();
    childProc.kill();
  }
});

test('where.sh exiting non-zero is UNKNOWN, not a clean placement', () => {
  const { install, project } = makeInstall();
  // Prints a line that looks resolved and then fails. Reading the stdout alone
  // would call this MATCH.
  stubHelper(install, 'scripts/where.sh',
    '#!/usr/bin/env bash\necho "resolved=true placement=herdr:w1:p1 terminal=herdr"\nexit 9\n');
  const result = diagnose(install, project, 'demo', 'agy');
  assert.match(result.stdout, /^placement: UNKNOWN where\.sh exited 9/m);
  assert.doesNotMatch(result.stdout, /^placement: MATCH/m);
});

test('an engine whose supervisor cannot be identified is UNKNOWN and prescribes nothing', () => {
  const { install, project } = makeInstall();
  stubHelper(install, 'scripts/remote.sh',
    '#!/usr/bin/env bash\nprintf \'demo\\tconnected (engine running, pid 4242) since 2026-01-01\\n\'\n');
  // Stands in for a host with no systemd: the command cannot answer, so the unit
  // state is unknown. A missing binary and a failing one land in the same branch.
  const binDir = path.join(install, 'stub-bin');
  const PATH = pathWithShim(binDir, 'systemctl', '#!/usr/bin/env bash\nexit 127\n');
  const result = diagnose(install, project, 'demo', 'agy', [], { PATH });
  assert.match(result.stdout, /^engine: UNKNOWN unit=unknown connected \(engine running/m);
  assert.doesNotMatch(result.stdout, /^engine: MISMATCH/m);
  assert.doesNotMatch(result.stdout, /systemctl --user restart/);
});

test('a guard that could only be half read is UNKNOWN, not intact', () => {
  const { install, project } = makeInstall();
  const holder = spawnHolder();
  const childProc = spawnHolder();
  writeSeat(install, project, {
    team: 'demo', role: 'agy', pid: holder.pid, start: holder.start,
    childPid: childProc.pid, childStart: childProc.start,
  });
  const hooksDir = path.join(project, '.agents');
  fs.mkdirSync(hooksDir, { recursive: true });
  const hooks = path.join(hooksDir, 'hooks.json');
  fs.writeFileSync(hooks, JSON.stringify({ hooks: [{ command: 'block-agmsg-inbox' }] }));
  fs.chmodSync(hooks, 0o000);
  try {
    const result = diagnose(install, project, 'demo', 'agy');
    assert.match(result.stdout, /^guard: UNKNOWN inbox_hook=unknown/m);
    assert.doesNotMatch(result.stdout, /^guard: MATCH/m);
  } finally {
    fs.chmodSync(hooks, 0o644);
    holder.kill();
    childProc.kill();
  }
});

// A pause is not one flag. SIGUSR1 (`resume`) clears manual_resume and
// human_input in the supervisor loop and never touches durable_attention;
// only reset_guard() clears that, and it refuses while the supervisor is
// alive. Advising `resume` for a durable_attention pause was found in the
// field: it reported success and delivery stayed stopped.
function pausedSeat(flags) {
  const { install, project } = makeInstall();
  const holder = spawnHolder();
  const childProc = spawnHolder();
  writeSeat(install, project, {
    team: 'demo', role: 'agy', pid: holder.pid, start: holder.start,
    childPid: childProc.pid, childStart: childProc.start, flags,
  });
  return { install, project, holder, childProc };
}

test('a human-flag pause is told to resume', () => {
  const { install, project, holder, childProc } = pausedSeat({ manualResumeRequired: true });
  try {
    const result = diagnose(install, project, 'demo', 'agy');
    assert.match(result.stdout, /^phase: BLOCKED .*manual_resume=true/m);
    assert.match(result.stdout, /agy-tui resume --project/);
    assert.doesNotMatch(result.stdout, /reset-guard --project/);
  } finally { holder.kill(); childProc.kill(); }
});

test('a durable_attention pause is not told to resume, because resume cannot clear it', () => {
  const { install, project, holder, childProc } = pausedSeat({ durableAttention: true });
  try {
    const result = diagnose(install, project, 'demo', 'agy');
    assert.match(result.stdout, /^phase: BLOCKED .*durable_attention=true/m);
    assert.match(result.stdout, /`resume` does not clear/);
    assert.match(result.stdout, /agy-tui stop --project/);
    assert.match(result.stdout, /agy-tui reset-guard --project/);
    // The resume line is what the field report followed to a dead end.
    assert.doesNotMatch(result.stdout, /agy-tui resume --project/);
  } finally { holder.kill(); childProc.kill(); }
});

test('both kinds of pause together still point at reset-guard', () => {
  const { install, project, holder, childProc } = pausedSeat({
    durableAttention: true, manualResumeRequired: true, humanInputActive: true,
  });
  try {
    const result = diagnose(install, project, 'demo', 'agy');
    assert.match(result.stdout, /^phase: BLOCKED .*durable_attention=true manual_resume=true human_input=true/m);
    // Saying only "run resume" here is the trap: the other flags would clear
    // and the operator would read that as success.
    assert.match(result.stdout, /reports success and leaves delivery stopped/);
    assert.match(result.stdout, /agy-tui reset-guard --project/);
  } finally { holder.kill(); childProc.kill(); }
});

test('NEEDS_ATTENTION without a batch carries the same way out', () => {
  const { install, project, holder, childProc } = pausedSeat({
    durableAttention: true, supervisorPhase: 'NEEDS_ATTENTION',
  });
  try {
    const result = diagnose(install, project, 'demo', 'agy');
    assert.match(result.stdout, /^phase: MISMATCH supervisor_phase=NEEDS_ATTENTION/m);
    assert.match(result.stdout, /agy-tui reset-guard --project/);
  } finally { holder.kill(); childProc.kill(); }
});
