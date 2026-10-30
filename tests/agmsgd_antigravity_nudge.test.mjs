// The Antigravity nudge channel: dry-run by default, live only behind a second
// switch, and only for a seat that passes all four conditions. A fake tmux
// records every call, so "nothing was typed" is checked against what the pane
// manager actually received.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, symlinkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openInstallDb } from '../scripts/daemon/db.mjs';
import { createAntigravityNudgeChannel, classifyExit, runNudge, remoteTargetConfigured } from '../scripts/daemon/channels/antigravity-nudge.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const screens = path.join(repo, 'tests', 'fixtures', 'agy-1.4.9-screens');
const statusScript = path.join(repo, 'scripts', 'daemon', 'status.mjs');
const LINE = /^\[agmsg:[A-Za-z0-9-]+\] New messages are waiting\. Check your agmsg inbox\.$/;

function addMessage(root, id) {
  const store = new DatabaseSync(path.join(root, 'db', 'messages.db'));
  store.exec(`INSERT INTO events (type, team, to_agent, id) VALUES ('message_sent', 'test', 'agy', '${id}')`);
  store.close();
}

function fixture(t, { screen = 'idle', wal = false, driver = 'tmux', agents = ['agy'] } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agmsgd-agy-nudge-'));
  const project = path.join(root, 'project');
  cpSync(path.join(repo, 'scripts'), path.join(root, 'scripts'), { recursive: true });
  for (const dir of ['run', 'db', 'bin', path.join('teams', 'test'), path.join('project', '.agent', 'rules')]) mkdirSync(path.join(root, dir), { recursive: true });
  writeFileSync(path.join(root, 'teams', 'test', 'config.json'), JSON.stringify({ agents: Object.fromEntries(agents.map(name => [name, { registrations: [{ type: 'antigravity', project }] }])) }));
  writeFileSync(path.join(project, '.agent', 'rules', 'agmsg.md'), '# agmsg Integration Rule\n## PostToolUse\nAfter each tool call, check the inbox.\n');
  for (const name of agents) writeFileSync(path.join(root, 'run', `spawn.test__${name}`), `${driver}:%1\t${project}\tantigravity\t\n`);
  if (driver === 'herdr') {
    // A stand-in for the herdr driver: tmux's reads (against the fake tmux), but typing and the
    // CLI are logged only, like `agent prompt` (types, does not submit) and `pane send-keys`.
    const base = path.join(root, 'scripts', 'drivers', 'terminals');
    rmSync(path.join(base, 'herdr'), { recursive: true, force: true });
    cpSync(path.join(base, 'tmux'), path.join(base, 'herdr'), { recursive: true });
    writeFileSync(path.join(base, 'herdr', 'terminal.conf'), readFileSync(path.join(base, 'tmux', 'terminal.conf'), 'utf8').replace('name=tmux', 'name=herdr'));
    const logFile = path.join(root, 'tmux.log');
    writeFileSync(path.join(base, 'herdr', 'ops.sh'), `${readFileSync(path.join(base, 'tmux', 'ops.sh'), 'utf8')}
terminal_poke() {
  echo "agent-prompt $2" >> '${logFile}'
  # What the screen shows after the typing: the line in the box (default), a confirmation screen, or nothing new.
  case "\${FAKE_AFTER:-box}" in
    box) awk -v t="$2" 'index($0, "38;5;12m>") && !d { sub(/>/, "> " t); d = 1 } 1' '${path.join(root, 'screen.ansi')}' > '${path.join(root, 'screen.tmp')}' && mv '${path.join(root, 'screen.tmp')}' '${path.join(root, 'screen.ansi')}' ;;
    # What a real agy showed after agent prompt on Windows (herdr 0.9.3): the line already in the conversation, the box empty.
    submitted) awk -v t="$2" 'index($0, "────") && !d { print "> " t; d = 1 } 1' '${path.join(root, 'screen.ansi')}' > '${path.join(root, 'screen.tmp')}' && mv '${path.join(root, 'screen.tmp')}' '${path.join(root, 'screen.ansi')}' ;;
    boxperm) awk -v t="$2" 'index($0, "38;5;12m>") && !d { sub(/>/, "> " t); d = 1 } 1' '${path.join(root, 'screen.ansi')}' > '${path.join(root, 'screen.tmp')}' && mv '${path.join(root, 'screen.tmp')}' '${path.join(root, 'screen.ansi')}'; printf 'Requesting permission for:\\n   cmd\\nRun this command?\\n> 1. Yes\\n' >> '${path.join(root, 'screen.ansi')}' ;;
    boxextra) awk -v t="$2 EXTRA" 'index($0, "38;5;12m>") && !d { sub(/>/, "> " t); d = 1 } 1' '${path.join(root, 'screen.ansi')}' > '${path.join(root, 'screen.tmp')}' && mv '${path.join(root, 'screen.tmp')}' '${path.join(root, 'screen.ansi')}' ;;
    submittedperm) awk -v t="$2" 'index($0, "────") && !d { print "> " t; d = 1 } 1' '${path.join(root, 'screen.ansi')}' > '${path.join(root, 'screen.tmp')}' && mv '${path.join(root, 'screen.tmp')}' '${path.join(root, 'screen.ansi')}'; printf 'Requesting permission for:\\n   cmd\\nRun this command?\\n> 1. Yes\\n' >> '${path.join(root, 'screen.ansi')}' ;;
    perm) cp '${path.join(screens, 'perm.ansi')}' '${path.join(root, 'screen.ansi')}' ;;
    draft) cp '${path.join(screens, 'draft.ansi')}' '${path.join(root, 'screen.ansi')}' ;;
  esac
  echo ok; return 0
}
_herdr_bare_of() { printf '%s' "$1"; }
_herdr_cli() {
  shift; echo "herdr $*" >> '${logFile}'
  case "$*" in
    "agent get "*) [ -n "\${FAKE_AGENT_JSON:-}" ] && echo "$FAKE_AGENT_JSON" ;;
    *"send-keys"*enter*) [ "\${FAKE_ENTER_SUBMITS:-}" = 1 ] && awk -v t="$(sed -n 's/^agent-prompt //p' '${logFile}' | tail -1)" 'index($0, "38;5;12m>") { sub(/> *[^\x1b]*/, ">") } index($0, "────") && !d { print "> " t; d = 1 } 1' '${path.join(root, 'screen.ansi')}' > '${path.join(root, 'screen.tmp')}' && mv '${path.join(root, 'screen.tmp')}' '${path.join(root, 'screen.ansi')}' ;;
  esac
  return "\${FAKE_HERDR_RC:-0}"
}
`);
  }
  if (driver === 'faketerm') {
    // tmux's driver plus a focus signal and the draft-recovery writers, each logging its call.
    const base = path.join(root, 'scripts', 'drivers', 'terminals');
    cpSync(path.join(base, 'tmux'), path.join(base, 'faketerm'), { recursive: true });
    writeFileSync(path.join(base, 'faketerm', 'terminal.conf'), readFileSync(path.join(base, 'tmux', 'terminal.conf'), 'utf8').replace('name=tmux', 'name=faketerm'));
    writeFileSync(path.join(base, 'faketerm', 'ops.sh'), `${readFileSync(path.join(base, 'tmux', 'ops.sh'), 'utf8')}\nterminal_pane_focused() { echo no; }\nterminal_input_clear() { echo "input-clear $1" >> '${path.join(root, 'tmux.log')}'; echo ok; }\nterminal_input_type() { echo "input-type $1" >> '${path.join(root, 'tmux.log')}'; echo ok; }\n`);
  }
  writeFileSync(path.join(root, 'run', 'delivery-choice'), `antigravity\t${project}\tagmsgd\n`);
  const store = new DatabaseSync(path.join(root, 'db', 'messages.db'));
  if (wal) store.exec('PRAGMA journal_mode=WAL');
  store.exec(`
    CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, team TEXT, to_agent TEXT, id TEXT, agent TEXT, msg_id TEXT, legacy_id INTEGER);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, team TEXT, to_agent TEXT, read_at TEXT);
    CREATE TABLE read_cursors (team TEXT, agent TEXT, local_position INTEGER);
    INSERT INTO events (type, team, to_agent, id) VALUES ('message_sent', 'test', 'agy', 'm1');`);
  store.close();
  const screenFile = path.join(root, 'screen.ansi');
  const setScreen = (name) => writeFileSync(screenFile, name === 'none' ? 'nothing like an input box\n' : readFileSync(path.join(screens, `${name}.ansi`)));
  setScreen(screen);
  const log = path.join(root, 'tmux.log');
  writeFileSync(path.join(root, 'bin', 'tmux'), `#!/bin/sh
echo "$*" >> '${log}'
case "$1" in capture-pane) if [ "$2" = -e ]; then cat '${screenFile}'; else sed 's/\\x1b\\[[0-9;]*m//g' '${screenFile}'; fi ;; esac
exit 0
`);
  chmodSync(path.join(root, 'bin', 'tmux'), 0o755);
  writeFileSync(path.join(root, 'bin', 'uname'), '#!/bin/sh\nif [ "$1" = -s ] && [ -n "$FAKE_UNAME_S" ]; then echo "$FAKE_UNAME_S"; else exec /usr/bin/uname "$@"; fi\n');
  chmodSync(path.join(root, 'bin', 'uname'), 0o755);
  const env = { PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, HOME: process.env.HOME, AGMSG_STORAGE_PATH: path.join(root, 'db'), AGMSG_CONFIG: path.join(root, 'config.json') };
  const db = openInstallDb(path.join(root, 'run', 'install.db'));
  const clock = { ms: Date.UTC(2026, 9, 29) };
  const logs = [];
  const channel = createAntigravityNudgeChannel({ db, installRoot: root, env, now: () => clock.ms, log: line => logs.push(line)});
  t.after(async () => { await channel.stop(); try { db.close(); } catch { /* closed */ } rmSync(root, { recursive: true, force: true }); });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  return {
    root, project, db, channel, clock, logs, setScreen, calls, env,
    sent: () => calls().filter(line => line.startsWith('send-keys') || line.startsWith('input-')),
    flag: (name) => writeFileSync(path.join(root, 'run', name), ''),
    row: () => db.prepare("SELECT * FROM beta_antigravity_nudge WHERE seat = '[\"test\",\"agy\"]'").get(),
  };
}

const typedText = (calls) => calls.find(line => line.startsWith('send-keys -l')).replace(/^.*-- /, '');

function snapshot(root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { out[`${path.relative(root, full)}/`] = ''; walk(full); continue; }
      const rel = path.relative(root, full);
      if (/^run\/(install\.db.*|agmsgd\.log)$/.test(rel) || rel === 'tmux.log' || rel.startsWith('scripts/')) continue;
      out[rel] = `${createHash('sha256').update(readFileSync(full)).digest('hex')}@${statSync(full).mtimeMs}`;
    }
  };
  walk(root);
  return out;
}

function otherTables(db) {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'beta_antigravity_nudge' ORDER BY name").all().map(row => row.name);
  return Object.fromEntries(names.map(name => [name, db.prepare(`SELECT * FROM ${name}`).all()]));
}

test('without the delivery file the channel does nothing: no table, no pane call', async (t) => {
  const f = fixture(t);
  f.flag('agmsgd-antigravity-live');
  const before = [snapshot(f.root), otherTables(f.db)];
  await f.channel.pollOnce();
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='beta_antigravity_nudge'").get().n, 0);
  assert.deepEqual(f.calls(), []);
  assert.deepEqual([snapshot(f.root), otherTables(f.db)], before);
});

test('with only the delivery file it is a dry-run: every check reads the real screen, nothing is typed, the would-be line is recorded', async (t) => {
  const f = fixture(t);
  f.flag('agmsgd-antigravity-delivery');
  await f.channel.pollOnce();
  const row = f.row();
  assert.deepEqual([row.state, row.reason, row.mode, row.up_to], ['dry_run', 'would_send', 'dry', '']);
  assert.match(row.would_send, LINE);
  assert.ok(f.calls().some(line => line.startsWith('capture-pane')), 'the screen was read');
  assert.deepEqual(f.sent(), []);
  // The same unread is not dry-run again.
  const reads = f.calls().length;
  await f.channel.pollOnce();
  assert.equal(f.calls().length, reads);
  assert.equal(f.row().up_to, '', 'a dry-run never advances the live notice cursor');
});

for (const screen of ['idle', 'busy', 'draft', 'perm']) {
  test(`dry-run on the ${screen} screen never types`, async (t) => {
    const f = fixture(t, { screen });
    f.flag('agmsgd-antigravity-delivery');
    await f.channel.pollOnce();
    assert.deepEqual(f.sent(), []);
  });
}

test('the live file alone never sends', async (t) => {
  const f = fixture(t);
  f.flag('agmsgd-antigravity-live');
  await f.channel.pollOnce();
  assert.deepEqual(f.calls(), []);
});

test('live (both files): one line is typed and submitted, the cursor advances, and the same unread is not sent twice', async (t) => {
  const f = fixture(t);
  f.flag('agmsgd-antigravity-delivery');
  f.flag('agmsgd-antigravity-live');
  await f.channel.pollOnce();
  assert.equal(f.sent().length, 2, 'text, then Enter');
  assert.match(typedText(f.calls()), LINE);
  assert.doesNotMatch(f.sent().join('\n'), /m1/, 'no message content is typed');
  const row = f.row();
  assert.deepEqual([row.state, row.reason, row.mode], ['delivering', 'nudged', 'live']);
  assert.ok(row.up_to && row.last_nudge_at);
  await f.channel.pollOnce();
  assert.equal(f.sent().length, 2);
  addMessage(f.root, 'm2');
  await f.channel.pollOnce();
  assert.equal(f.sent().length, 4, 'a new unread gets one more notice');
});

test('the busy screen is sent to (agy queues it); a draft and a permission screen are not', async (t) => {
  const busy = fixture(t, { screen: 'busy' });
  busy.flag('agmsgd-antigravity-delivery'); busy.flag('agmsgd-antigravity-live');
  await busy.channel.pollOnce();
  assert.equal(busy.sent().length, 2);
  for (const [screen, state, reason] of [['draft', 'deferred', 'draft'], ['perm', 'blocked', 'confirmation_screen']]) {
    const f = fixture(t, { screen });
    f.flag('agmsgd-antigravity-delivery'); f.flag('agmsgd-antigravity-live');
    await f.channel.pollOnce();
    assert.deepEqual(f.sent(), []);
    assert.deepEqual([f.row().state, f.row().reason, f.row().up_to], [state, reason, '']);
  }
});

test('a draft backs off exponentially; a confirmation screen is re-judged only every 60 s and then sends once it is gone', async (t) => {
  const f = fixture(t, { screen: 'draft' });
  f.flag('agmsgd-antigravity-delivery'); f.flag('agmsgd-antigravity-live');
  await f.channel.pollOnce();
  const waits = [];
  for (let i = 0; i < 3; i += 1) {
    const row = f.row();
    waits.push(Date.parse(row.next_try_at) - f.clock.ms);
    f.clock.ms = Date.parse(row.next_try_at) + 1;
    await f.channel.pollOnce();
  }
  assert.deepEqual(waits, [5000, 10000, 20000]);
  f.setScreen('perm');
  f.clock.ms = Date.parse(f.row().next_try_at) + 1;
  await f.channel.pollOnce();
  assert.equal(f.row().reason, 'confirmation_screen');
  const reads = f.calls().length;
  f.clock.ms += 10_000;
  await f.channel.pollOnce();
  assert.equal(f.calls().length, reads, 'not re-read before the recheck time');
  f.setScreen('idle');
  f.clock.ms += 61_000;
  await f.channel.pollOnce();
  assert.equal(f.sent().length, 2);
  assert.equal(f.row().state, 'delivering');
});

test('an input box that cannot be located is deferred, and blocked after ten refusals in a row', async (t) => {
  const f = fixture(t, { screen: 'none' });
  f.flag('agmsgd-antigravity-delivery'); f.flag('agmsgd-antigravity-live');
  for (let i = 0; i < 10; i += 1) {
    await f.channel.pollOnce();
    if (i < 9) assert.deepEqual([f.row().state, f.row().reason], ['deferred', 'input_box_unconfirmed']);
    f.clock.ms = Date.parse(f.row().next_try_at) + 1;
  }
  assert.deepEqual([f.row().state, f.row().reason, f.row().attempts], ['blocked', 'input_box_unconfirmed', 10]);
  assert.deepEqual(f.sent(), []);
});

const NEGATIVES = {
  'no delivery choice recorded': { reason: 'delivery_not_chosen', set: (f) => rmSync(path.join(f.root, 'run', 'delivery-choice')) },
  'the project chose monitor': { reason: 'delivery_not_chosen', set: (f) => writeFileSync(path.join(f.root, 'run', 'delivery-choice'), `antigravity\t${f.project}\tmonitor\n`) },
  'a different project chose agmsgd': { reason: 'delivery_not_chosen', set: (f) => writeFileSync(path.join(f.root, 'run', 'delivery-choice'), `antigravity\t/elsewhere\tagmsgd\n`) },
  'a supervisor reservation exists (even a stale one)': { reason: 'supervisor_present', set: (f) => writeFileSync(path.join(f.root, 'run', 'read-reservation.test__agy.json'), JSON.stringify({ type: 'antigravity', kind: 'tui-pty', pid: 1, start: 'x', state: '/nowhere' })) },
  'an unreadable reservation': { reason: 'supervisor_present', set: (f) => writeFileSync(path.join(f.root, 'run', 'read-reservation.test__agy.json'), '{ broken') },
  'a legacy-format reservation without a type exists': { reason: 'supervisor_present', set: (f) => writeFileSync(path.join(f.root, 'run', 'antigravity-reservation.test__agy.json'), JSON.stringify({ pid: 1, start: 'x', state: '/nowhere' })) },
  'both reservation formats exist': { reason: 'supervisor_present', set: (f) => { writeFileSync(path.join(f.root, 'run', 'antigravity-reservation.test__agy.json'), JSON.stringify({ pid: 1 })); writeFileSync(path.join(f.root, 'run', 'read-reservation.test__agy.json'), JSON.stringify({ type: 'antigravity' })); } },
  'a reservation is a dangling symlink': { reason: 'supervisor_present', set: (f) => symlinkSync('/nonexistent-target', path.join(f.root, 'run', 'read-reservation.test__agy.json')) },
  'the rule file is the monitor marker': { reason: 'monitor_mode', set: (f) => writeFileSync(path.join(f.project, '.agent', 'rules', 'agmsg.md'), '<!-- agmsg:antigravity:monitor -->\n# agmsg Integration Rule\n') },
  'the terminal manager is aimed at another machine': { reason: 'remote_pane_unsupported', env: { HERDR_MACHINE: 'other' } },
};
for (const [name, spec] of Object.entries(NEGATIVES)) {
  test(`a seat is never touched when ${name}: no pane call at all, even in live`, async (t) => {
    const f = fixture(t);
    f.flag('agmsgd-antigravity-delivery'); f.flag('agmsgd-antigravity-live');
    spec.set?.(f);
    const channel = spec.env ? createAntigravityNudgeChannel({ db: f.db, installRoot: f.root, env: { ...f.env, ...spec.env }, now: () => f.clock.ms, log: () => {}}) : f.channel;
    await channel.pollOnce();
    await channel.stop();
    assert.deepEqual(f.calls(), []);
    assert.deepEqual([f.row().state, f.row().reason, f.row().up_to], ['ineligible', spec.reason, '']);
  });
}

test('a seat without a placement record is unaddressable and nothing is typed', async (t) => {
  const f = fixture(t);
  f.flag('agmsgd-antigravity-delivery'); f.flag('agmsgd-antigravity-live');
  rmSync(path.join(f.root, 'run', 'spawn.test__agy'));
  await f.channel.pollOnce();
  assert.deepEqual([f.row().state, f.row().reason], ['unaddressable', 'no_placement']);
  assert.deepEqual(f.calls(), []);
});

test('an unreadable message store sends nothing and the reason carries no path', async (t) => {
  const f = fixture(t);
  f.flag('agmsgd-antigravity-delivery'); f.flag('agmsgd-antigravity-live');
  rmSync(path.join(f.root, 'db', 'messages.db'));
  await f.channel.pollOnce();
  assert.equal(f.row().state, 'blocked');
  assert.match(f.row().reason, /^message_store_unreadable(:E[A-Z]+)?$/);
  assert.deepEqual(f.calls(), []);
  assert.doesNotMatch(JSON.stringify([f.db.prepare('SELECT * FROM beta_antigravity_nudge').all(), f.logs]), new RegExp(f.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('exit codes map to fixed states', () => {
  assert.deepEqual(classifyExit(0), { sent: true });
  const expected = { 14: ['deferred', 'draft'], 15: ['deferred', 'input_box_unconfirmed'], 16: ['blocked', 'confirmation_screen'], 10: ['unaddressable', 'pane_unreachable'],
    12: ['unaddressable', 'pane_unreachable'], 13: ['unaddressable', 'no_pane'], 20: ['unaddressable', 'no_placement'], 21: ['unaddressable', 'placement_unresolved'],
    22: ['blocked', 'seat_type_mismatch'], 99: ['blocked', 'nudge_failed'] };
  for (const [code, [state, reason]] of Object.entries(expected)) assert.deepEqual([classifyExit(Number(code)).state, classifyExit(Number(code)).reason], [state, reason], `exit ${code}`);
  assert.equal(classifyExit(16).backoff, undefined, 'a confirmation screen is not retried with backoff');
});

test('a hung or cancelled nudge is killed and reported without output', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agmsgd-agy-run-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'slow.sh'), 'sleep 30\n');
  const started = Date.now();
  assert.deepEqual(await runNudge({ script: path.join(dir, 'slow.sh'), mode: 'dry', team: 't', agent: 'a', text: 'x', timeoutMs: 200 }), { kind: 'timeout', typed: false });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  assert.deepEqual(await runNudge({ script: path.join(dir, 'slow.sh'), mode: 'dry', team: 't', agent: 'a', text: 'x', timeoutMs: 10_000, signal: controller.signal }), { kind: 'cancelled', typed: false });
  assert.ok(Date.now() - started < 8000);
});

test('writes only a line into the pane and its own table: files, other tables and the message store are untouched', async (t) => {
  for (const wal of [false, true]) {
    const f = fixture(t, { wal });
    f.flag('agmsgd-antigravity-delivery'); f.flag('agmsgd-antigravity-live');
    const before = [snapshot(f.root), otherTables(f.db)];
    const storeBefore = createHash('sha256').update(readFileSync(path.join(f.root, 'db', 'messages.db'))).digest('hex');
    for (let i = 0; i < 3; i += 1) await f.channel.pollOnce();
    assert.equal(f.sent().length, 2);
    const after = snapshot(f.root);
    for (const key of Object.keys({ ...before[0], ...after })) {
      if (/^db\/messages\.db-(shm|wal)$/.test(key)) { assert.equal(wal, true, `${key} appeared in a non-WAL store`); continue; }
      assert.equal(after[key], before[0][key], key);
    }
    assert.deepEqual(otherTables(f.db), before[1]);
    assert.equal(createHash('sha256').update(readFileSync(path.join(f.root, 'db', 'messages.db'))).digest('hex'), storeBefore);
  }
});

test('status shows the dry-run line, then the live notice and how long it has stayed unread', async (t) => {
  const f = fixture(t);
  f.flag('agmsgd-antigravity-delivery');
  await f.channel.pollOnce();
  const run = (...flags) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', statusScript, f.root, ...flags], { encoding: 'utf8' });
  assert.match(run(), /^Antigravity test\/agy: agmsgd DRY-RUN \(types nothing\): dry_run \(would_send\); last dry-run \d+[smh] ago; would have typed: \[agmsg:[A-Za-z0-9-]+\] New messages are waiting\. Check your agmsg inbox\.$/m);
  assert.equal(JSON.parse(run('--json')).antigravity_nudge.live, false);
  f.flag('agmsgd-antigravity-live');
  addMessage(f.root, 'm2');
  await f.channel.pollOnce();
  const text = run();
  assert.match(text, /^Antigravity test\/agy: agmsgd delivering: delivering \(nudged\); last nudge \d+[smh] ago; still unread \d+[smh] after the last nudge/m);
  const json = JSON.parse(run('--json')).antigravity_nudge;
  assert.deepEqual([json.enabled, json.live, json.seats[0].state], [true, true, 'delivering']);
});

test('status is silent and says disabled without the delivery file', (t) => {
  const f = fixture(t);
  f.db.close();
  const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', statusScript, f.root], { encoding: 'utf8' });
  assert.doesNotMatch(out, /Antigravity/);
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', statusScript, f.root, '--json'], { encoding: 'utf8' })).antigravity_nudge, { enabled: false, live: false, state: 'disabled', seats: [] });
});

test('the sources have no way to reach another machine or message content', () => {
  const channel = readFileSync(path.join(repo, 'scripts', 'daemon', 'channels', 'antigravity-nudge.mjs'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(channel, /\b(writeFile|writeFileSync|appendFile|appendFileSync|rename|renameSync|unlink|unlinkSync|rm|rmSync|mkdir|mkdirSync|chmod|copyFile|symlink)\b/);
  assert.doesNotMatch(channel, /--machine|node:net|node:http|\bssh\b/);
  const wrapper = readFileSync(path.join(repo, 'scripts', 'daemon', 'agy-nudge.sh'), 'utf8').replace(/^\s*#.*$/gm, '');
  assert.doesNotMatch(wrapper, /--machine|\bssh\b|\btmux\b|send\.sh|\/poke\.sh/);
  // The one key it can send is the Enter after typing: herdr only, live only, once.
  assert.equal((wrapper.match(/send-keys/g) ?? []).length, 1);
  assert.match(wrapper, /pane send-keys "\$\(_herdr_bare_of "\$BARE_ID"\)" enter/);
  assert.ok(wrapper.indexOf('send-keys') > wrapper.indexOf('[ "$MODE" = live ] || exit 0'));
  assert.equal(remoteTargetConfigured({ HERDR_MACHINE: 'x' }), true);
  assert.equal(remoteTargetConfigured({ HERDR_MACHINE: '' }), false);
  assert.equal(remoteTargetConfigured({ PATH: '/bin' }), false);
});

for (const mode of ['dry', 'live']) {
  test(`${mode}: a herdr-style draft (unfocused) is refused without saving the draft or touching the box`, async (t) => {
    const f = fixture(t, { screen: 'draft', driver: 'faketerm' });
    f.flag('agmsgd-antigravity-delivery');
    if (mode === 'live') f.flag('agmsgd-antigravity-live');
    const before = snapshot(f.root);
    await f.channel.pollOnce();
    assert.deepEqual([f.row().state, f.row().reason], ['deferred', 'draft']);
    assert.deepEqual(f.sent(), [], 'no clear, no type, no send');
    assert.deepEqual(readdirSync(path.join(f.root, 'run')).filter(name => name.startsWith('poke-draft')), []);
    assert.deepEqual(snapshot(f.root), before);
  });
}

test('the same driver still delivers on an idle screen (the recovery switch-off does not break the normal path)', async (t) => {
  const f = fixture(t, { screen: 'idle', driver: 'faketerm' });
  f.flag('agmsgd-antigravity-delivery'); f.flag('agmsgd-antigravity-live');
  await f.channel.pollOnce();
  assert.equal(f.sent().length, 2);
  assert.equal(f.row().state, 'delivering');
});

test('switches are read again for every seat: removing live (or delivery) during the first seat changes the second', async (t) => {
  for (const removed of ['agmsgd-antigravity-live', 'agmsgd-antigravity-delivery']) {
    const f = fixture(t, { agents: ['agy', 'agy2'] });
    const store = new DatabaseSync(path.join(f.root, 'db', 'messages.db'));
    store.exec("INSERT INTO events (type, team, to_agent, id) VALUES ('message_sent', 'test', 'agy2', 'm9')");
    store.close();
    f.flag('agmsgd-antigravity-delivery'); f.flag('agmsgd-antigravity-live');
    const modes = [];
    const channel = createAntigravityNudgeChannel({
      db: f.db, installRoot: f.root, env: f.env, now: () => f.clock.ms, log: () => {},
      run: async ({ mode, agent }) => { modes.push([agent, mode]); rmSync(path.join(f.root, 'run', removed), { force: true }); return { kind: 'exit', code: 0 }; },
    });
    await channel.pollOnce();
    await channel.stop();
    const rows = Object.fromEntries(f.db.prepare('SELECT seat, mode, state, up_to, would_send FROM beta_antigravity_nudge').all().map(row => [JSON.parse(row.seat)[1], row]));
    if (removed.endsWith('live')) {
      assert.deepEqual(modes, [['agy', 'live'], ['agy2', 'dry']]);
      assert.deepEqual([rows.agy.mode, rows.agy.state], ['live', 'delivering']);
      assert.deepEqual([rows.agy2.mode, rows.agy2.state, rows.agy2.up_to === ''], ['dry', 'dry_run', true], 'the second seat is a dry-run and its live cursor stays empty');
    } else {
      assert.deepEqual(modes, [['agy', 'live']], 'with delivery gone no second run is started');
      assert.equal(rows.agy2, undefined);
    }
  }
});

test('a switch removed after the seat was read but before the run is not overtaken', async (t) => {
  const f = fixture(t);
  f.flag('agmsgd-antigravity-delivery'); f.flag('agmsgd-antigravity-live');
  const modes = [];
  const channel = createAntigravityNudgeChannel({
    db: f.db, installRoot: f.root, env: f.env, now: () => f.clock.ms, log: () => {},
    // The store read happens just before the run; removing the flag there is the window.
    readSnapshot: (...args) => { rmSync(path.join(f.root, 'run', 'agmsgd-antigravity-live'), { force: true }); return { state: 'ok', unread: true, upTo: '{"eventSeq":1,"legacyId":0}' }; },
    openStore: () => ({ close() {} }),
    run: async ({ mode }) => { modes.push(mode); return { kind: 'exit', code: 0 }; },
  });
  await channel.pollOnce();
  await channel.stop();
  assert.deepEqual(modes, [], 'the run was not started from the earlier live value');
});

// ---- Windows (Git Bash) path: exercised here with an injected platform; the real
// ---- machine is a separate, approved measurement.
import { unconfirmedReason, nudgeTimeoutFor, chosenAgmsgd, ineligibleReason, readDeliveryModeStrict, resolveBash, toNativeWindowsPath, toPosixScriptPath } from '../scripts/daemon/channels/antigravity-nudge.mjs';

const WIN_PROJECT = '/c/Users/Me/proj';
function winFixture(t, { readMode } = {}) {
  const f = fixture(t);
  writeFileSync(path.join(f.root, 'teams', 'test', 'config.json'), JSON.stringify({ agents: { agy: { registrations: [{ type: 'antigravity', project: WIN_PROJECT }] } } }));
  writeFileSync(path.join(f.root, 'run', 'delivery-choice'), `antigravity\t${WIN_PROJECT}\tagmsgd\r\n`);
  f.flag('agmsgd-antigravity-delivery'); f.flag('agmsgd-antigravity-live');
  const seen = [];
  const run = async (options) => { seen.push(options); return runNudge({ ...options, platform: 'linux', bash: 'bash' }); };
  const make = (extra = {}) => createAntigravityNudgeChannel({
    db: f.db, installRoot: f.root, env: f.env, now: () => f.clock.ms, log: () => {}, hostPlatform: 'win32',
    findBash: () => 'C:\\Program Files\\Git\\bin\\bash.exe', ...(readMode ? { readMode } : {}), ...extra,
  });
  return { ...f, seen, make, run };
}

test('B2: Windows project spellings are one absolute drive path; relative, drive-relative and UNC forms are refused; the root keeps its separator', () => {
  const forms = ['C:\\Users\\Me\\proj', 'C:/Users/Me/proj', '/c/Users/Me/proj', 'c:/Users/Me/proj/', '/C/Users/Me//proj'];
  assert.deepEqual([...new Set(forms.map(toNativeWindowsPath))], ['C:/Users/Me/proj']);
  assert.equal(toNativeWindowsPath('C:/'), 'C:/');
  assert.equal(toNativeWindowsPath('/c/'), 'C:/');
  assert.equal(toNativeWindowsPath('/c'), 'C:/');
  for (const bad of ['C:', 'C:proj', 'proj', 'relative\\path', '\\\\server\\share\\x', '//server/share/x', '/home/u/x', '', undefined, 42]) assert.equal(toNativeWindowsPath(bad), null, String(bad));
  assert.notEqual(toNativeWindowsPath('/c/Users/Me/proj'), toNativeWindowsPath('/c/Users/Me/PROJ'), 'case is kept: a directory can be case-sensitive');
  assert.notEqual(toNativeWindowsPath('/c/Users/Me/proj'), toNativeWindowsPath('/d/Users/Me/proj'));
});

test('B2: the Windows delivery choice needs the same absolute path; the drive root choice never covers "C:"; the last line wins; only an explicit agmsgd counts', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agmsgd-agy-win-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'run'));
  const write = (text) => writeFileSync(path.join(root, 'run', 'delivery-choice'), text);
  write('antigravity\t/c/Users/Me/proj\tagmsgd\r\n');
  assert.equal(chosenAgmsgd(root, ['C:\\Users\\Me\\proj'], 'win32'), true);
  assert.equal(chosenAgmsgd(root, ['C:/Users/Me/PROJ'], 'win32'), false, 'a different case is not assumed to be the same folder');
  assert.equal(chosenAgmsgd(root, ['C:/Users/Me/other'], 'win32'), false);
  assert.equal(chosenAgmsgd(root, [], 'win32'), false);
  write('antigravity\tC:/\tagmsgd\n');
  assert.equal(chosenAgmsgd(root, ['C:'], 'win32'), false, 'drive-relative C: is not the root');
  assert.equal(chosenAgmsgd(root, ['C:/'], 'win32'), true);
  assert.equal(chosenAgmsgd(root, ['C:/Users'], 'win32'), false);
  write('antigravity\tC:\tagmsgd\n');
  assert.equal(chosenAgmsgd(root, ['C:/'], 'win32'), false, 'a drive-relative choice line is refused too');
  write('antigravity\t/c/Users/Me/proj\tagmsgd\nantigravity\t/c/Users/Me/proj\tmonitor\n');
  assert.equal(chosenAgmsgd(root, ['C:/Users/Me/proj'], 'win32'), false, 'a later monitor choice overrides');
  // A later opt-out spelled with different letter case is never skipped as "another project".
  write('antigravity\t/c/Users/Me/proj\tagmsgd\nantigravity\t/c/users/me/proj\tmonitor\n');
  assert.equal(chosenAgmsgd(root, ['C:/Users/Me/proj'], 'win32'), false);
  assert.equal(chosenAgmsgd(root, ['C:/users/me/proj'], 'win32'), false);
  write('antigravity\t/c/users/me/proj\tmonitor\nantigravity\t/c/Users/Me/proj\tagmsgd\n');
  assert.equal(chosenAgmsgd(root, ['C:/Users/Me/proj'], 'win32'), false, 'order does not matter');
  write('antigravity\t/c/Users/Me/proj\tagmsgd\nantigravity\t/c/users/me/proj\tagmsgd\n');
  assert.equal(chosenAgmsgd(root, ['C:/Users/Me/proj'], 'win32'), false, 'two case-different entries (possibly two folders) are not told apart');
  // Different folders stay independent.
  write('antigravity\t/c/Users/Me/proj\tagmsgd\nantigravity\t/c/Users/Me/other\tmonitor\nantigravity\t/d/Users/Me/proj\tmonitor\n');
  assert.equal(chosenAgmsgd(root, ['C:/Users/Me/proj'], 'win32'), true);
  assert.equal(chosenAgmsgd(root, ['C:/Users/Me/proj', 'C:/Users/Me/other'], 'win32'), false, 'every project of the seat must have chosen agmsgd');
  write('claude-code\t/c/Users/Me/proj\tagmsgd\n');
  assert.equal(chosenAgmsgd(root, ['C:/Users/Me/proj'], 'win32'), false, 'another type does not count');
  rmSync(path.join(root, 'run', 'delivery-choice'));
  assert.equal(chosenAgmsgd(root, ['C:/Users/Me/proj'], 'win32'), false);
  write('antigravity\t/c/Users/Me/proj\tagmsgd\n');
  assert.equal(chosenAgmsgd(root, ['C:/Users/Me/proj'], 'linux'), false, 'the POSIX rule is unchanged');
});

test('B1: only an absolute, real, non-WSL Git/MSYS bash.exe is accepted, wherever the candidate came from', () => {
  const files = new Set([
    'C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\msys-2.0.dll',
    'C:\\Windows\\System32\\bash.exe', 'C:\\Windows\\System32\\usr\\bin\\msys-2.0.dll',
    'C:\\Users\\Me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe',
    'D:\\Tools\\Git\\usr\\bin\\bash.exe', 'D:\\Tools\\Git\\usr\\bin\\msys-2.0.dll',
    'C:\\Users\\Me\\custom\\bin\\bash.exe', 'C:\\Users\\Me\\custom\\usr\\bin\\msys-2.0.dll',
    'E:\\nodll\\bin\\bash.exe', 'C:\\Users\\Me\\link\\bash.exe',
  ]);
  const dirs = new Set(['C:\\Program Files\\Git\\bin\\notafile.exe']);
  const isFile = (p) => files.has(p) && !dirs.has(p);
  const links = { 'C:\\Users\\Me\\link\\bash.exe': 'C:\\Windows\\System32\\bash.exe' };
  const realpath = (p) => links[p] ?? p;
  const env = (extra) => ({ SystemRoot: 'C:\\Windows', ...extra });
  const pick = (extra) => resolveBash({ platform: 'win32', env: env(extra), isFile, realpath });
  assert.equal(resolveBash({ platform: 'linux' }), 'bash');
  assert.equal(resolveBash({ platform: 'darwin' }), 'bash');
  assert.equal(pick({ ProgramFiles: 'C:\\Program Files', PATH: 'C:\\Windows\\System32' }), 'C:\\Program Files\\Git\\bin\\bash.exe');
  assert.equal(pick({ PATH: 'C:\\Windows\\System32;D:\\Tools\\Git\\usr\\bin\\' }), 'D:\\Tools\\Git\\usr\\bin\\bash.exe');
  assert.equal(pick({ AGMSG_BASH: 'C:/Users/Me/custom/bin/bash.exe' }), 'C:\\Users\\Me\\custom\\bin\\bash.exe', 'a custom Git/MSYS install is allowed when it passes every check');
  // The inputs from the review, each now refused:
  for (const refused of ['bash', 'bash.exe', 'C:/Windows/System32/bash.exe', 'C:\\Windows\\System32\\bash.exe', 'c:/windows/system32/bash.exe',
    'C:/Users/Me/AppData/Local/Microsoft/WindowsApps/bash.exe', '\\\\server\\share\\bin\\bash.exe', 'C:\\Program Files\\Git\\bin\\notafile.exe',
    'C:/Users/Me/link/bash.exe', 'E:/nodll/bin/bash.exe', 'C:\\Program Files\\Git\\bin', '']) {
    assert.equal(pick({ AGMSG_BASH: refused }), null, `AGMSG_BASH=${refused}`);
  }
  assert.equal(resolveBash({ platform: 'win32', env: env({ AGMSG_BASH: 'C:/Program Files/Git/bin/bash.exe' }), isFile: () => true, realpath: () => { throw new Error('unresolvable'); } }), null, 'a path that cannot be resolved is refused');
  assert.equal(pick({ PATH: 'C:\\Windows\\System32' }), null, 'nothing named: no bash');
  assert.equal(resolveBash({ platform: 'win32', env: { ProgramFiles: 'C:\\Windows\\Git' }, isFile: () => true, realpath: (p) => p }), null, 'under the Windows directory');
});

test('the script path is handed to Git Bash in /c/... form on Windows and untouched elsewhere', () => {
  assert.equal(toPosixScriptPath('C:\\Users\\Me\\agmsg\\scripts\\daemon\\agy-nudge.sh', 'win32'), '/c/Users/Me/agmsg/scripts/daemon/agy-nudge.sh');
  assert.equal(toPosixScriptPath('D:/x/y.sh', 'win32'), '/d/x/y.sh');
  assert.equal(toPosixScriptPath('/home/u/y.sh', 'win32'), '/home/u/y.sh');
  assert.equal(toPosixScriptPath('/home/u/y.sh', 'linux'), '/home/u/y.sh');
});

test('B3: on Windows the rule file is read from the native path of the registration, and an unreadable rule never passes the gate', () => {
  const asked = [];
  const base = { installRoot: '/unused', env: {}, platform: 'win32' };
  const registration = { team: 't', agent: 'a', projects: [WIN_PROJECT] };
  // delivery-choice is not consulted in this unit: stub the gate order by giving a root with a choice.
  const root = mkdtempSync(path.join(os.tmpdir(), 'agmsgd-agy-win-rule-'));
  mkdirSync(path.join(root, 'run'));
  writeFileSync(path.join(root, 'run', 'delivery-choice'), `antigravity\t${WIN_PROJECT}\tagmsgd\n`);
  try {
    const reason = (readMode) => ineligibleReason({ ...base, installRoot: root, registration, readMode });
    assert.equal(reason((projects) => { asked.push(projects); return 'turn'; }), '');
    assert.deepEqual(asked, [['C:/Users/Me/proj']], 'the rule is read from C:/Users/Me/proj, not C:/c/Users/Me/proj');
    assert.equal(reason(() => 'monitor'), 'monitor_mode');
    assert.equal(reason(() => 'unreadable'), 'rule_unreadable');
    assert.equal(ineligibleReason({ ...base, installRoot: root, registration: { ...registration, projects: ['relative'] }, readMode: () => 'turn' }), 'delivery_not_chosen');
  } finally { rmSync(root, { recursive: true, force: true }); }
  // The strict reader: marker found, plain turn rule, absent file, unreadable file, missing folder.
  const files = { 'C:/p/.agent/rules/agmsg.md': '<!-- agmsg:antigravity:monitor -->\r\n# x\n' };
  const readFile = (file) => { if (file in files) return files[file]; const error = new Error('x'); error.code = file.includes('denied') ? 'EACCES' : 'ENOENT'; throw error; };
  const isDirectory = (dir) => dir !== 'C:/gone';
  const strict = (projects) => readDeliveryModeStrict(projects, { readFile, isDirectory });
  assert.equal(strict(['C:/p']), 'monitor', 'CRLF marker line is recognised');
  assert.equal(strict(['C:/q']), 'none');
  assert.equal(strict(['C:/gone']), 'unreadable');
  assert.equal(strict(['C:/denied']), 'unreadable');
  files['C:/turn/.agent/rules/agmsg.md'] = '# agmsg\n';
  assert.equal(strict(['C:/turn']), 'turn');
  assert.equal(strict(['C:/turn', 'C:/p']), 'monitor');
});

test('B3 end to end: a Windows-style registration whose rule file holds the monitor marker is never run, because the native path is read', async (t) => {
  const asked = [];
  const f = winFixture(t, { readMode: (projects) => { asked.push(projects); return projects[0] === 'C:/Users/Me/proj' ? 'monitor' : 'none'; } });
  const channel = f.make();
  await channel.pollOnce();
  await channel.stop();
  assert.deepEqual(asked, [['C:/Users/Me/proj']]);
  assert.deepEqual([f.row().state, f.row().reason], ['ineligible', 'monitor_mode']);
  assert.deepEqual(f.calls(), []);
  assert.equal(f.seen.length, 0);
});

test('windows host: an unreadable rule folder (the default strict reader on a missing path) is refused and nothing runs', async (t) => {
  const f = winFixture(t);
  const channel = f.make();
  await channel.pollOnce();
  await channel.stop();
  assert.deepEqual([f.row().state, f.row().reason], ['ineligible', 'rule_unreadable']);
  assert.deepEqual(f.calls(), []);
});

test('windows host: no usable Git Bash means unaddressable and nothing runs', async (t) => {
  const f = winFixture(t, { readMode: () => 'turn' });
  const channel = f.make({ findBash: () => null, run: async () => { throw new Error('must not run'); } });
  await channel.pollOnce();
  await channel.stop();
  assert.deepEqual([f.row().state, f.row().reason], ['unaddressable', 'bash_unavailable']);
  assert.deepEqual(f.calls(), []);
});

test('windows host end to end: resolved bash, /c/... script path via the spawn, no process group, and the gates still apply', async (t) => {
  const f = winFixture(t, { readMode: () => 'turn' });
  const spawned = [];
  const run = (options) => runNudge({
    ...options,
    spawnProcess: (command, args, opts) => { spawned.push({ command, args, detached: opts.detached }); return spawn('bash', args, opts); },
  });
  await f.make({ run }).pollOnce();
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, 'C:\\Program Files\\Git\\bin\\bash.exe');
  assert.equal(spawned[0].detached, false);
  assert.deepEqual(spawned[0].args.slice(1), ['live', 'test', 'agy', '--body', '-']);
  assert.equal(f.sent().length, 2);
  assert.equal(f.row().state, 'delivering');
  addMessage(f.root, 'm2');
  const before = spawned.length;
  await f.make({ run, readMode: () => 'monitor' }).pollOnce();
  assert.equal(spawned.length, before);
  assert.equal(f.row().reason, 'monitor_mode');
});

test('windows host: a hung nudge ends the process tree and is reported', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agmsgd-agy-wkill-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'slow.sh'), 'sleep 30\n');
  const killed = [];
  const result = await runNudge({
    script: path.join(dir, 'slow.sh'), mode: 'dry', team: 't', agent: 'a', text: 'x', timeoutMs: 150, platform: 'win32',
    killTree: (pid) => { killed.push(pid); try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } },
  });
  assert.deepEqual(result, { kind: 'timeout', typed: false });
  assert.ok(killed.length >= 1 && Number.isInteger(killed[0]));
});

test('a nudge gets a longer bound on Windows (about 10 s there), still under the 30 s channel deadline', () => {
  assert.equal(nudgeTimeoutFor('linux'), 10_000);
  assert.equal(nudgeTimeoutFor('darwin'), 10_000);
  assert.equal(nudgeTimeoutFor('win32'), 25_000);
  assert.ok(nudgeTimeoutFor('win32') < 30_000);
});

// ---- Enter after typing (Windows + herdr): every path is pinned with a stand-in herdr driver.
function enterFixture(t, { screen = 'idle', driver = 'herdr', extraEnv = {}, live = true } = {}) {
  const f = fixture(t, { screen, driver });
  f.flag('agmsgd-antigravity-delivery');
  if (live) f.flag('agmsgd-antigravity-live');
  const channel = createAntigravityNudgeChannel({ db: f.db, installRoot: f.root, env: { ...f.env, ...extraEnv }, now: () => f.clock.ms, log: () => {} });
  t.after(() => channel.stop());
  const prompts = () => f.calls().filter(line => line.startsWith('agent-prompt'));
  const enters = () => f.calls().filter(line => /^herdr pane send-keys .* enter$/.test(line));
  return { ...f, channel, prompts, enters };
}
const WIN = { FAKE_UNAME_S: 'MINGW64_NT-10.0-26300' };

const SUBMITTED_JSON = '{"result":{"agent":{"agent_status":"working"}}}';

test('Windows + herdr, live: agent prompt submits by itself, so no Enter is sent, and the line showing in the conversation confirms the delivery', async (t) => {
  const f = enterFixture(t, { extraEnv: { ...WIN, FAKE_AFTER: 'submitted' } });
  await f.channel.pollOnce();
  assert.equal(f.prompts().length, 1);
  assert.match(f.prompts()[0], /^agent-prompt \[agmsg:[A-Za-z0-9-]+\] New messages are waiting\./);
  assert.deepEqual(f.enters(), [], 'no Enter: it is not needed and a stray one is avoided');
  assert.deepEqual([f.row().state, f.row().reason], ['delivering', 'nudged']);
  await f.channel.pollOnce();
  assert.equal(f.prompts().length, 1);
});

test('R1: herdr reporting the agent as working is not evidence for this notice (another turn can be running)', async (t) => {
  const f = enterFixture(t, { extraEnv: { ...WIN, FAKE_AFTER: 'empty', FAKE_AGENT_JSON: SUBMITTED_JSON } });
  await f.channel.pollOnce();
  assert.deepEqual(f.enters(), []);
  assert.deepEqual([f.row().state, f.row().reason], ['blocked', 'enter_unconfirmed:box_empty']);
});

test('B2: the token only inside the input box (a changed draft) is not a submitted line; the token in the conversation is, even when a confirmation screen has appeared since', async (t) => {
  const extra = enterFixture(t, { extraEnv: { ...WIN, FAKE_AFTER: 'boxextra' } });
  await extra.channel.pollOnce();
  assert.deepEqual([extra.row().state, extra.row().reason], ['blocked', 'enter_unconfirmed:box_mismatch']);
  assert.deepEqual(extra.enters(), []);
  const submittedPerm = enterFixture(t, { extraEnv: { ...WIN, FAKE_AFTER: 'submittedperm' } });
  await submittedPerm.channel.pollOnce();
  assert.deepEqual([submittedPerm.row().state, submittedPerm.row().reason], ['delivering', 'nudged']);
  assert.deepEqual(submittedPerm.enters(), []);
});

test('B1: a new Enter is sent only to a live input box that holds exactly this line; a confirmation screen below it stops it', async (t) => {
  const perm = enterFixture(t, { extraEnv: { AGMSG_AGY_NUDGE_ENTER: 'always', FAKE_AFTER: 'boxperm', FAKE_ENTER_SUBMITS: '1' } });
  await perm.channel.pollOnce();
  assert.deepEqual(perm.enters(), [], 'no key sent toward a confirmation screen');
  assert.equal(perm.row().reason, 'enter_unconfirmed:confirmation_screen');
  const ok = enterFixture(t, { extraEnv: { AGMSG_AGY_NUDGE_ENTER: 'always', FAKE_AFTER: 'box', FAKE_ENTER_SUBMITS: '1' } });
  await ok.channel.pollOnce();
  assert.equal(ok.enters().length, 1);
  assert.equal(ok.row().state, 'delivering');
});

test('Enter: dry-run types nothing and checks nothing, whatever the setting', async (t) => {
  for (const mode of ['auto', 'always']) {
    const f = enterFixture(t, { extraEnv: { ...WIN, AGMSG_AGY_NUDGE_ENTER: mode }, live: false });
    await f.channel.pollOnce();
    assert.deepEqual([f.prompts(), f.enters()], [[], []]);
    assert.deepEqual([f.row().state, f.row().reason], ['dry_run', 'would_send']);
  }
});

test('Enter: other environments are unchanged (not Windows, another terminal, off) and "always" still sends one Enter for a line left in the box', async (t) => {
  const linux = enterFixture(t);
  await linux.channel.pollOnce();
  assert.deepEqual([linux.prompts().length, linux.enters(), linux.calls().filter(line => line.startsWith('herdr agent get'))], [1, [], []]);
  assert.equal(linux.row().state, 'delivering');
  const tmux = enterFixture(t, { driver: 'tmux', extraEnv: { ...WIN, AGMSG_AGY_NUDGE_ENTER: 'always' } });
  await tmux.channel.pollOnce();
  assert.deepEqual(tmux.enters(), [], 'tmux submits through its own driver; the herdr block does not run');
  const off = enterFixture(t, { extraEnv: { ...WIN, AGMSG_AGY_NUDGE_ENTER: 'off' } });
  await off.channel.pollOnce();
  assert.deepEqual([off.prompts().length, off.enters()], [1, []]);
  assert.equal(off.row().state, 'delivering');
  const forced = enterFixture(t, { extraEnv: { AGMSG_AGY_NUDGE_ENTER: 'always', FAKE_ENTER_SUBMITS: '1' } });
  await forced.channel.pollOnce();
  assert.deepEqual(forced.enters(), ['herdr pane send-keys %1 enter'], 'always: herdr on any OS, the line was in the box');
  assert.equal(forced.row().state, 'delivering');
});

test('Enter: a refused typing (draft, confirmation screen) sends neither the line nor an Enter', async (t) => {
  for (const screen of ['draft', 'perm']) {
    const f = enterFixture(t, { screen, extraEnv: WIN });
    await f.channel.pollOnce();
    assert.deepEqual([f.prompts(), f.enters()], [[], []], screen);
  }
});

test('a line left in the box is not delivered: counted as notified, shown with its reason, never typed again, and no Enter by default', async (t) => {
  const f = enterFixture(t, { extraEnv: { ...WIN, FAKE_AFTER: 'box' } });
  await f.channel.pollOnce();
  assert.equal(f.prompts().length, 1);
  assert.deepEqual(f.enters(), []);
  const row = f.row();
  assert.deepEqual([row.state, row.reason, row.attempts, row.next_try_at], ['blocked', 'enter_unconfirmed:box_has_line', 0, null]);
  assert.ok(row.up_to && row.last_nudge_at);
  await f.channel.pollOnce(); await f.channel.pollOnce();
  assert.equal(f.prompts().length, 1);
  assert.deepEqual([f.row().state, f.row().reason], ['blocked', 'enter_unconfirmed:box_has_line']);
});

test('always: a failing Enter is reported as enter_send_failed, once', async (t) => {
  const f = enterFixture(t, { extraEnv: { AGMSG_AGY_NUDGE_ENTER: 'always', FAKE_HERDR_RC: '1', FAKE_AFTER: 'box' } });
  await f.channel.pollOnce();
  assert.equal(f.enters().length, 1);
  assert.equal(f.row().reason, 'enter_unconfirmed:enter_send_failed');
  await f.channel.pollOnce();
  assert.equal(f.enters().length, 1);
  assert.equal(f.prompts().length, 1);
});

test('the reason is a single word in status, with the line counted as the last nudge', async (t) => {
  const f = enterFixture(t, { extraEnv: { ...WIN, FAKE_AFTER: 'box' } });
  await f.channel.pollOnce();
  f.db.close();
  const text = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', statusScript, f.root], { encoding: 'utf8' });
  assert.match(text, /Antigravity test\/agy: agmsgd delivering: blocked \(enter_unconfirmed:box_has_line\); last nudge \d+[smh] ago/);
});

test('a run cut short after typing is treated like an unconfirmed Enter; one cut short before typing is not', async (t) => {
  for (const [result, expected, advanced] of [
    [{ kind: 'timeout', typed: true }, 'enter_unconfirmed:timeout', true],
    [{ kind: 'timeout', typed: true, reasonWord: 'box_empty' }, 'enter_unconfirmed:timeout:box_empty', true],
    [{ kind: 'timeout', typed: true, reasonWord: '/tmp/secret' }, 'enter_unconfirmed:timeout', true],
    [{ kind: 'exit', code: 23, typed: true }, 'enter_unconfirmed', true],
    [{ kind: 'exit', code: 23, typed: true, reasonWord: 'box_empty' }, 'enter_unconfirmed:box_empty', true],
    [{ kind: 'exit', code: 23, typed: true, reasonWord: '/tmp/secret' }, 'enter_unconfirmed', true],
    [{ kind: 'timeout', typed: false }, 'nudge_timeout', false],
    [{ kind: 'exit', code: 12, typed: false }, 'pane_unreachable', false],
  ]) {
    const f = fixture(t);
    f.flag('agmsgd-antigravity-delivery'); f.flag('agmsgd-antigravity-live');
    const channel = createAntigravityNudgeChannel({ db: f.db, installRoot: f.root, env: f.env, now: () => f.clock.ms, log: () => {}, run: async () => result });
    await channel.pollOnce();
    await channel.stop();
    assert.equal(f.row().reason, expected, JSON.stringify(result));
    assert.equal(Boolean(f.row().up_to), advanced, JSON.stringify(result));
  }
  assert.deepEqual(classifyExit(23), { state: 'blocked', reason: 'enter_unconfirmed', typed: true });
});

test('runNudge reports typing that happened before a stop (the wrapper prints one marker after typing)', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agmsgd-agy-typed-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'typed-then-hang.sh'), 'echo NUDGE-TYPED\nsleep 30\n');
  writeFileSync(path.join(dir, 'hang.sh'), 'sleep 30\n');
  assert.deepEqual(await runNudge({ script: path.join(dir, 'typed-then-hang.sh'), mode: 'live', team: 't', agent: 'a', text: 'x', timeoutMs: 400 }), { kind: 'timeout', typed: true });
  assert.deepEqual(await runNudge({ script: path.join(dir, 'hang.sh'), mode: 'live', team: 't', agent: 'a', text: 'x', timeoutMs: 400 }), { kind: 'timeout', typed: false });
});

test('after typing, a confirmation screen, another draft or an empty box is reported with its own reason word, and nothing is typed twice', async (t) => {
  for (const [after, word] of [['perm', 'confirmation_screen'], ['draft', 'box_mismatch'], ['empty', 'box_empty']]) {
    const f = enterFixture(t, { extraEnv: { ...WIN, FAKE_AFTER: after } });
    await f.channel.pollOnce();
    assert.equal(f.prompts().length, 1, `${after}: the line was typed`);
    assert.deepEqual(f.enters(), [], `${after}: no Enter`);
    const row = f.row();
    assert.deepEqual([row.state, row.reason, row.attempts, row.next_try_at], ['blocked', `enter_unconfirmed:${word}`, 0, null], after);
    assert.ok(row.up_to && row.last_nudge_at, `${after}: counted as notified`);
    await f.channel.pollOnce();
    assert.equal(f.prompts().length, 1, `${after}: never typed a second time`);
  }
});

test('runNudge reads the reason word even when it is split across chunks, and ignores a word it does not know', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agmsgd-agy-reason-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'a.sh'), "echo NUDGE-TYPED\nprintf 'NUDGE-REA'\nsleep 0.2\nprintf 'SON:box_em'\nsleep 0.2\nprintf 'pty\\n'\nexit 23\n");
  writeFileSync(path.join(dir, 'b.sh'), "echo NUDGE-TYPED\necho 'NUDGE-REASON:/tmp/secret'\nexit 23\n");
  const a = await runNudge({ script: path.join(dir, 'a.sh'), mode: 'live', team: 't', agent: 'a', text: 'x', timeoutMs: 5000 });
  assert.deepEqual([a.kind, a.code, a.typed, a.reasonWord], ['exit', 23, true, 'box_empty']);
  const b = await runNudge({ script: path.join(dir, 'b.sh'), mode: 'live', team: 't', agent: 'a', text: 'x', timeoutMs: 5000 });
  assert.equal(b.reasonWord, undefined);
});

test('B2: a typed marker split across stdout chunks is still recognised (timeout and abnormal exit)', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agmsgd-agy-split-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const split of [1, 3, 5, 6, 10]) {
    for (const tail of ['sleep 30', 'exit 9']) {
      const marker = 'NUDGE-TYPED';
      writeFileSync(path.join(dir, 's.sh'), `printf '%s' '${marker.slice(0, split)}'\nsleep 0.2\nprintf '%s\\n' '${marker.slice(split)}'\n${tail}\n`);
      let typedCalls = 0;
      const result = await runNudge({ script: path.join(dir, 's.sh'), mode: 'live', team: 't', agent: 'a', text: 'x', timeoutMs: 900, onTyped: () => { typedCalls += 1; } });
      assert.equal(result.typed, true, `split ${split} / ${tail}`);
      assert.equal(typedCalls, 1, 'onTyped runs once');
      assert.equal(result.kind, tail === 'exit 9' ? 'exit' : 'timeout');
    }
  }
  writeFileSync(path.join(dir, 'n.sh'), "printf '%s' 'NUDGE-'\nsleep 0.2\nprintf '%s\\n' 'OTHER'\nsleep 30\n");
  assert.equal((await runNudge({ script: path.join(dir, 'n.sh'), mode: 'live', team: 't', agent: 'a', text: 'x', timeoutMs: 700 })).typed, false);
});

test('B3: a stop after typing leaves the notice counted and unconfirmed, and the next poll does not type again', async (t) => {
  const f = fixture(t);
  f.flag('agmsgd-antigravity-delivery'); f.flag('agmsgd-antigravity-live');
  let runs = 0;
  const make = (run) => createAntigravityNudgeChannel({ db: f.db, installRoot: f.root, env: f.env, now: () => f.clock.ms, log: () => {}, run });
  const after = make(async (options) => { runs += 1; options.onTyped(); return { kind: 'cancelled', typed: true }; });
  await after.pollOnce(); await after.stop();
  assert.deepEqual([f.row().state, f.row().reason, f.row().inflight_up_to], ['blocked', 'enter_unconfirmed', '']);
  assert.ok(f.row().up_to && f.row().last_nudge_at);
  const again = make(async () => { runs += 1; return { kind: 'exit', code: 0, typed: true }; });
  await again.pollOnce(); await again.pollOnce(); await again.stop();
  assert.equal(runs, 1, 'the typed line is not typed again');
  assert.deepEqual([f.row().state, f.row().reason], ['blocked', 'enter_unconfirmed']);
});

// The review's reproduction: the real deadline, a run that only learns it typed after the deadline passed.
async function deadlineHarness(t, runAfterAbort) {
  const f = fixture(t);
  f.flag('agmsgd-antigravity-delivery'); f.flag('agmsgd-antigravity-live');
  const { pollChannelHooks } = await import('../scripts/daemon/main.mjs');
  const calls = { runs: 0, typedThrew: 0, lines: [] };
  const channel = createAntigravityNudgeChannel({
    db: f.db, installRoot: f.root, env: f.env, now: () => f.clock.ms, log: (line) => calls.lines.push(line),
    run: async (options) => {
      calls.runs += 1;
      if (calls.runs > 1) return { kind: 'exit', code: 0, typed: true };
      await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }));
      return runAfterAbort(options, calls);
    },
  });
  t.after(() => channel.stop());
  const poll = (timeoutMs) => pollChannelHooks([channel], () => {}, { timeoutMs, installRoot: f.root });
  return { ...f, channel, calls, poll };
}

test('B3 (deadline order): abort, then a late typed notice that cannot be written, then cancelled: the next poll does not type again', async (t) => {
  const h = await deadlineHarness(t, (options, calls) => {
    try { options.onTyped(); } catch { calls.typedThrew += 1; }
    return { kind: 'cancelled', typed: true };
  });
  await h.poll(30);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(h.calls.runs, 1);
  assert.equal(h.calls.typedThrew, 1, 'the late write was refused: the expired scope is not relaxed');
  assert.ok(h.row().inflight_up_to, 'the in-flight record written before the run is still there');
  await h.poll(2000);
  assert.equal(h.calls.runs, 1, 'the same unread is not typed again');
  const row = h.row();
  assert.deepEqual([row.state, row.reason, row.inflight_up_to], ['blocked', 'interrupted_unconfirmed', '']);
  assert.ok(row.up_to && row.last_nudge_at);
  await h.poll(2000);
  assert.equal(h.calls.runs, 1);
  assert.deepEqual([h.row().state, h.row().reason], ['blocked', 'interrupted_unconfirmed'], 'kept visible');
});

test('B3 (deadline order): a run cut off with no typed marker seen is retried normally (the marker comes after typing, so this narrows the doubt only)', async (t) => {
  const h = await deadlineHarness(t, () => ({ kind: 'cancelled', typed: false }));
  await h.poll(30);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(h.calls.runs, 1);
  assert.ok(h.row().inflight_up_to);
  assert.equal(h.row().up_to, '', 'not counted as notified');
  await h.poll(2000);
  assert.equal(h.calls.runs, 2, 'no typed marker was seen: nudged again');
  assert.deepEqual([h.row().state, h.row().reason, h.row().inflight_up_to], ['delivering', 'nudged', '']);
});

test('B3 (restart): an in-flight record left by an earlier process is never typed again, and the table gains the column if it predates it', async (t) => {
  const f = fixture(t);
  f.flag('agmsgd-antigravity-delivery'); f.flag('agmsgd-antigravity-live');
  let runs = 0;
  const make = () => createAntigravityNudgeChannel({ db: f.db, installRoot: f.root, env: f.env, now: () => f.clock.ms, log: () => {}, run: async () => { runs += 1; return { kind: 'cancelled', typed: false }; } });
  const first = make();
  await first.pollOnce(); await first.stop();
  assert.equal(runs, 1);
  // A new process has no memory of whether that run showed the typed marker: it must not guess.
  const second = make();
  await second.pollOnce(); await second.stop();
  assert.equal(runs, 1);
  assert.deepEqual([f.row().state, f.row().reason], ['blocked', 'interrupted_unconfirmed']);
  // A table created before the column existed is migrated.
  f.db.exec('DROP TABLE beta_antigravity_nudge');
  f.db.exec("CREATE TABLE beta_antigravity_nudge (seat TEXT PRIMARY KEY, state TEXT NOT NULL, reason TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'dry', up_to TEXT NOT NULL DEFAULT '', dry_up_to TEXT NOT NULL DEFAULT '', last_nudge_at TEXT, last_dry_at TEXT, would_send TEXT, unread INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, next_try_at TEXT, checked_at TEXT NOT NULL)");
  const third = createAntigravityNudgeChannel({ db: f.db, installRoot: f.root, env: f.env, now: () => f.clock.ms, log: () => {}, run: async () => ({ kind: 'exit', code: 0, typed: true }) });
  await third.pollOnce(); await third.stop();
  assert.ok(f.db.prepare('PRAGMA table_info(beta_antigravity_nudge)').all().some((column) => column.name === 'inflight_up_to'));
  assert.equal(f.row().state, 'delivering');
});

test('unconfirmedReason tells a finished check apart from a run stopped at its time limit, and keeps a word already printed', () => {
  assert.equal(unconfirmedReason(undefined, 'exit'), 'enter_unconfirmed');
  assert.equal(unconfirmedReason('box_has_line', 'exit'), 'enter_unconfirmed:box_has_line');
  assert.equal(unconfirmedReason('box_has_line'), 'enter_unconfirmed:box_has_line');
  assert.equal(unconfirmedReason(undefined, 'timeout'), 'enter_unconfirmed:timeout');
  assert.equal(unconfirmedReason('box_empty', 'timeout'), 'enter_unconfirmed:timeout:box_empty');
  assert.equal(unconfirmedReason('/tmp/secret', 'timeout'), 'enter_unconfirmed:timeout');
  assert.equal(unconfirmedReason('/tmp/secret', 'exit'), 'enter_unconfirmed');
});

test('runNudge keeps a reason word that was printed before the time limit, and records the stages as numbers', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agmsgd-agy-stages-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'word-then-hang.sh'), 'echo NUDGE-TYPED\necho NUDGE-CHECK:1\necho NUDGE-REASON:box_empty\nsleep 30\n');
  writeFileSync(path.join(dir, 'checks.sh'), "echo NUDGE-TYPED\nprintf 'NUDGE-CH'\nsleep 0.1\nprintf 'ECK:1\\n'\nsleep 0.1\necho NUDGE-CHECK:2\nsleep 0.1\necho NUDGE-CHECK:3\nexit 0\n");
  const stages = {};
  const result = await runNudge({ script: path.join(dir, 'word-then-hang.sh'), mode: 'live', team: 't', agent: 'a', text: 'x', timeoutMs: 600, stages });
  assert.deepEqual(result, { kind: 'timeout', typed: true, reasonWord: 'box_empty' });
  assert.equal(stages.checks, 1);
  assert.ok(stages.typedMs >= 0 && stages.typedMs <= stages.lastCheckMs && stages.lastCheckMs <= stages.totalMs, JSON.stringify(stages));
  const ok = {};
  const done = await runNudge({ script: path.join(dir, 'checks.sh'), mode: 'live', team: 't', agent: 'a', text: 'x', timeoutMs: 5000, stages: ok });
  assert.deepEqual([done.kind, done.code], ['exit', 0]);
  assert.equal(ok.checks, 3, 'a check marker split across chunks is still counted, and each is counted once');
  assert.ok(ok.typedMs <= ok.lastCheckMs && ok.lastCheckMs <= ok.totalMs, JSON.stringify(ok));
  // without a stages object nothing changes
  assert.deepEqual(await runNudge({ script: path.join(dir, 'word-then-hang.sh'), mode: 'live', team: 't', agent: 'a', text: 'x', timeoutMs: 400 }), { kind: 'timeout', typed: true, reasonWord: 'box_empty' });
});

test('a finished run is recorded as one nudge_run line with numbers and fixed words only, and a time-limit stop shows as its own reason', async (t) => {
  const f = fixture(t);
  f.flag('agmsgd-antigravity-delivery'); f.flag('agmsgd-antigravity-live');
  const lines = [];
  const channel = createAntigravityNudgeChannel({ db: f.db, installRoot: f.root, env: f.env, now: () => f.clock.ms, log: (m) => lines.push(m), run: async (options) => {
    Object.assign(options.stages, { typedMs: 17000, checks: 2, lastCheckMs: 19500, totalMs: 25300 });
    return { kind: 'timeout', typed: true };
  } });
  await channel.pollOnce();
  await channel.stop();
  assert.deepEqual([f.row().state, f.row().reason], ['blocked', 'enter_unconfirmed:timeout']);
  const runs = lines.filter((line) => line.includes('"nudge_run"')).map((line) => JSON.parse(line));
  assert.equal(runs.length, 1);
  assert.deepEqual(Object.keys(runs[0]).sort(), ['channel', 'checks', 'code', 'event', 'last_check_ms', 'mode', 'peek_seen_ms', 'peeks_ms', 'reason', 'result', 'seat', 'seen_ms', 'total_ms', 'typed_ms', 'wrapper_ms']);
  assert.deepEqual([runs[0].result, runs[0].code, runs[0].typed_ms, runs[0].checks, runs[0].last_check_ms, runs[0].total_ms, runs[0].reason, runs[0].mode],
    ['timeout', null, 17000, 2, 19500, 25300, 'enter_unconfirmed:timeout', 'live']);
  assert.ok(!lines.some((line) => line.includes('New messages are waiting')), 'the notice text is never logged');
  assert.ok(lines.some((line) => line.includes('"live:enter_unconfirmed:timeout"') || line.includes('live:enter_unconfirmed:timeout')), 'the seat_state line carries the new reason');
});

test('a confirmed run is recorded too (nudged), and a refused one carries its reason', async (t) => {
  for (const [result, reason] of [[{ kind: 'exit', code: 0, typed: true }, 'nudged'], [{ kind: 'exit', code: 14, typed: false }, 'draft']]) {
    const f = fixture(t);
    f.flag('agmsgd-antigravity-delivery'); f.flag('agmsgd-antigravity-live');
    const lines = [];
    const channel = createAntigravityNudgeChannel({ db: f.db, installRoot: f.root, env: f.env, now: () => f.clock.ms, log: (m) => lines.push(m), run: async (options) => { options.stages.totalMs = 12000; return result; } });
    await channel.pollOnce();
    await channel.stop();
    const run = lines.filter((line) => line.includes('"nudge_run"')).map((line) => JSON.parse(line));
    assert.equal(run.length, 1);
    assert.deepEqual([run[0].reason, run[0].result, run[0].code, run[0].total_ms, run[0].typed_ms], [reason, 'exit', result.code, 12000, null]);
  }
});

test('B1: a run that ends with an error after the poll deadline writes no nudge_run line (an expired scope cannot publish late writes)', async (t) => {
  const h = await deadlineHarness(t, () => ({ kind: 'failed' }));
  await h.poll(30);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(h.calls.runs, 1);
  assert.deepEqual(h.calls.lines.filter((line) => line.includes('"nudge_run"')), [], 'no diagnostic line after the deadline');
  // the same run inside a live scope is recorded
  const g = await deadlineHarness(t, () => ({ kind: 'failed' }));
  g.calls.runs = 1; // second call onward returns a confirmed exit (the harness's later-poll behaviour)
  await g.poll(2000);
  assert.equal(g.calls.lines.filter((line) => line.includes('"nudge_run"')).length, 1, 'inside an active poll the run is recorded');
});

test('stage markers that arrive in one chunk are not ordered by the clock: typing is first, every event of the chunk shares one time, duplicates count once', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agmsgd-agy-chunk-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'one-chunk.sh'), "printf 'NUDGE-TYPED\\nNUDGE-CHECK:1\\nNUDGE-CHECK:1\\nNUDGE-CHECK:2\\n'\nexit 0\n");
  let ticks = 0;
  const stages = {};
  const result = await runNudge({ script: path.join(dir, 'one-chunk.sh'), mode: 'live', team: 't', agent: 'a', text: 'x', timeoutMs: 5000, stages, clock: () => { ticks += 1; return ticks; } });
  assert.deepEqual([result.kind, result.code], ['exit', 0]);
  assert.equal(stages.checks, 2, 'a duplicate marker is counted once');
  assert.ok(stages.typedMs <= stages.lastCheckMs, `typing is never later than a check: ${JSON.stringify(stages)}`);
  assert.ok(stages.lastCheckMs <= stages.totalMs, JSON.stringify(stages));
});

// ---- Stage marks (wrapper -> daemon): measurement only; no limit, deadline or delivery decision uses them.
function stageFixture(t, opts = {}, extraEnv = {}) {
  const f = fixture(t, opts);
  f.flag('agmsgd-antigravity-delivery');
  if (opts.live !== false) f.flag('agmsgd-antigravity-live');
  const lines = [];
  const channel = createAntigravityNudgeChannel({ db: f.db, installRoot: f.root, env: { ...f.env, ...extraEnv }, now: () => f.clock.ms, log: (line) => lines.push(line) });
  t.after(() => channel.stop());
  const runs = () => lines.filter((line) => line.includes('"nudge_run"')).map((line) => JSON.parse(line));
  const prompts = () => f.calls().filter(line => line.startsWith('agent-prompt'));
  return { ...f, channel, lines, runs, prompts };
}

test('runNudge reads stage marks as whole lines once each: split across chunks, repeated, unknown names, malformed numbers and over-long lines are ignored', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agmsgd-agy-marks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'marks.sh'), [
    "printf 'NUDGE-STAGE:libs:12\\n'",
    "printf 'NUDGE-STAGE:lib'; sleep 0.1; printf 's:99\\n'",            // the second libs (split) is ignored: first one wins
    "printf 'NUDGE-STAGE:resolved:34\\nNUDGE-STAGE:peek:50\\nNUDGE-STAGE:peek:1050\\n'",
    "printf 'NUDGE-STAGE:evil:1\\nNUDGE-STAGE:poked:x1\\nNUDGE-STAGE:poked:-5\\nNUDGE-STAGE:poked:1234567890\\n'",
    "printf 'NUDGE-STAGE:poked:1100\\r\\n'",
    "printf 'a%.0s' $(seq 1 400); printf '\\nNUDGE-STAGE:peek:2000\\n'",
    "exit 0", ''].join('\n'));
  const stages = {};
  const result = await runNudge({ script: path.join(dir, 'marks.sh'), mode: 'live', team: 't', agent: 'a', text: 'x', timeoutMs: 5000, stages });
  assert.deepEqual([result.kind, result.code], ['exit', 0]);
  assert.deepEqual(stages.wrapperMs, { libs: 12, resolved: 34, poked: 1100 });
  assert.deepEqual(stages.peeksMs, [50, 1050, 2000]);
  assert.equal(stages.peekSeenMs.length, 3);
  assert.deepEqual(Object.keys(stages.seenMs).sort(), ['libs', 'poked', 'resolved']);
  const capped = {};
  writeFileSync(path.join(dir, 'many.sh'), "for i in $(seq 1 40); do printf 'NUDGE-STAGE:peek:%s\\n' $i; done\n");
  await runNudge({ script: path.join(dir, 'many.sh'), mode: 'live', team: 't', agent: 'a', text: 'x', timeoutMs: 5000, stages: capped });
  assert.equal(capped.peeksMs.length, 12, 'bounded');
  // without a stages object nothing is read or kept
  assert.equal((await runNudge({ script: path.join(dir, 'marks.sh'), mode: 'live', team: 't', agent: 'a', text: 'x', timeoutMs: 5000 })).code, 0);
});

test('live through the real wrapper: nudge_run carries the wrapper stages and the peek marks, in order, and nothing from the notice', async (t) => {
  const f = stageFixture(t, { screen: 'idle', driver: 'herdr' }, { ...WIN, FAKE_AFTER: 'submitted' });
  await f.channel.pollOnce();
  const [run] = f.runs();
  assert.ok(run, JSON.stringify(f.lines));
  assert.equal(run.result, 'exit');
  for (const name of ['libs', 'resolved', 'poked']) assert.ok(Number.isInteger(run.wrapper_ms[name]) && run.wrapper_ms[name] >= 0, `${name}: ${JSON.stringify(run.wrapper_ms)}`);
  assert.ok(run.wrapper_ms.libs <= run.wrapper_ms.resolved && run.wrapper_ms.resolved <= run.wrapper_ms.poked, JSON.stringify(run.wrapper_ms));
  assert.ok(run.peeks_ms.length >= 3, `safe-poke reads twice, then at least one delivery check reads: ${JSON.stringify(run.peeks_ms)}`);
  assert.deepEqual([...run.peeks_ms].sort((a, b) => a - b), run.peeks_ms, 'peek marks are in order');
  assert.equal(run.peek_seen_ms.length, run.peeks_ms.length);
  assert.ok(run.peeks_ms[1] >= run.peeks_ms[0] + 900, 'the second safe-poke read comes after its 1 s settle');
  assert.ok(run.peeks_ms[1] <= run.wrapper_ms.poked && run.wrapper_ms.poked <= run.peeks_ms[2], 'the two safe-poke reads, then the poke, then the first check read');
  const text = JSON.stringify(run);
  assert.ok(!/New messages are waiting|agmsg:|\/tmp|\/c\/|project/.test(text), 'no notice text, nonce or path');
  assert.equal(f.prompts().length, 1, 'one line typed; the wrapped functions changed nothing about delivery');
  assert.equal(f.row().state, 'delivering');
});

test('dry through the real wrapper: stages up to the safety decision are recorded, and nothing is typed', async (t) => {
  const f = stageFixture(t, { screen: 'idle', driver: 'herdr', live: false }, { ...WIN });
  await f.channel.pollOnce();
  const [run] = f.runs();
  assert.ok(run, JSON.stringify(f.lines));
  assert.equal(run.mode, 'dry');
  assert.ok('libs' in run.wrapper_ms && 'resolved' in run.wrapper_ms && 'poked' in run.wrapper_ms, JSON.stringify(run.wrapper_ms));
  assert.equal(run.peeks_ms.length, 2, 'dry: safe-poke reads twice and the no-op poke follows; no delivery check runs');
  assert.deepEqual(f.prompts(), [], 'dry types nothing');
});

test('an early refusal (a draft in the box) records the stages it reached: no second read, no poke', async (t) => {
  const f = stageFixture(t, { screen: 'draft', driver: 'herdr' }, { ...WIN });
  await f.channel.pollOnce();
  const [run] = f.runs();
  assert.ok(run, JSON.stringify(f.lines));
  assert.equal(run.code, 14);
  assert.ok('libs' in run.wrapper_ms && 'resolved' in run.wrapper_ms, JSON.stringify(run.wrapper_ms));
  assert.ok(!('poked' in run.wrapper_ms), 'the poke was never reached');
  assert.equal(run.peeks_ms.length, 1, 'refused after the first read');
  assert.deepEqual(f.prompts(), []);
});

test('the wrapper keeps the shared safe-poke.sh untouched, sends marks to a copied fd only, and the daemon file reads them as data', () => {
  const wrapper = readFileSync(path.join(repo, 'scripts', 'daemon', 'agy-nudge.sh'), 'utf8');
  assert.match(wrapper, /exec 7>&1/);
  assert.match(wrapper, />&7 2>\/dev\/null \|\| true/);
  assert.match(wrapper, /_agy_wrap terminal_peek_styled peek/);
  assert.match(wrapper, /_agy_wrap terminal_poke poked/);
  assert.match(wrapper, /EPOCHREALTIME/);
  assert.match(wrapper, /date \+%s%3N/);
  assert.ok(!readFileSync(path.join(repo, 'scripts', 'lib', 'safe-poke.sh'), 'utf8').includes('NUDGE-STAGE'), 'no mark is added inside the shared file');
});

// ---- The typed / check / reason decisions must not depend on how the pipe cuts the output, or on stage lines being there.
function pipeChild(pieces, { closeCode = null } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = Object.assign(new EventEmitter(), { destroy() {} }); child.stderr = Object.assign(new EventEmitter(), { destroy() {} });
    child.stdin = { on() {}, end() {} };
    child.kill = () => {}; child.unref = () => {};
    setImmediate(async () => {
      for (const piece of pieces) { child.stdout.emit('data', Buffer.from(piece)); await new Promise((resolve) => setImmediate(resolve)); }
      if (closeCode !== null) child.emit('close', closeCode);
    });
    return child;
  };
}
const WRAPPER_OUTPUT = (withStages) => [
  'NUDGE-TYPED', 'NUDGE-CHECK:1', ...(withStages ? ['NUDGE-STAGE:peek:19000'] : []), 'NUDGE-CHECK:2',
  ...(withStages ? ['NUDGE-STAGE:peek:20000', 'NUDGE-STAGE:poked:18500'] : []), 'NUDGE-REASON:box_empty', '',
].join('\n');
const splitsOf = (text) => [[text], ...Array.from({ length: text.length - 1 }, (_, i) => [text.slice(0, i + 1), text.slice(i + 1)]), [...text]];

test('B1: the typed marker, the checks and the reason are found in one large pipe read and at every split point, with or without stage lines and a stages object', async () => {
  for (const withStages of [false, true]) {
    for (const keepStages of [false, true]) {
      for (const pieces of splitsOf(WRAPPER_OUTPUT(withStages))) {
        let typedCalls = 0;
        const stages = keepStages ? {} : undefined;
        const result = await runNudge({ script: '/x/agy-nudge.sh', mode: 'live', team: 't', agent: 'a', text: 'x', timeoutMs: 5000, stages, onTyped: () => { typedCalls += 1; }, spawnProcess: pipeChild(pieces, { closeCode: 23 }) });
        const label = `stages=${withStages} object=${keepStages} pieces=${pieces.length}`;
        assert.deepEqual([result.kind, result.code, result.typed, result.reasonWord], ['exit', 23, true, 'box_empty'], label);
        assert.equal(typedCalls, 1, `onTyped exactly once: ${label}`);
        if (keepStages) assert.equal(stages.checks, 2, `both checks counted once: ${label}`);
      }
    }
  }
});

test('B1: an abort after a large pipe read still reports that it typed, with or without stage lines (so the next poll never types again)', async () => {
  for (const withStages of [false, true]) {
    for (const pieces of [[WRAPPER_OUTPUT(withStages)], [...splitsOf(WRAPPER_OUTPUT(withStages))[40]]]) {
      let typedCalls = 0;
      const controller = new AbortController();
      const run = runNudge({ script: '/x/agy-nudge.sh', mode: 'live', team: 't', agent: 'a', text: 'x', timeoutMs: 60000, signal: controller.signal, stages: {}, onTyped: () => { typedCalls += 1; }, spawnProcess: pipeChild(pieces) });
      await new Promise((resolve) => setTimeout(resolve, 150));
      controller.abort();
      const result = await run;
      assert.deepEqual([result.kind, result.typed, result.reasonWord, typedCalls], ['cancelled', true, 'box_empty', 1], `stages=${withStages} pieces=${pieces.length}`);
    }
  }
});
