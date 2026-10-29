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
  assert.deepEqual(await runNudge({ script: path.join(dir, 'slow.sh'), mode: 'dry', team: 't', agent: 'a', text: 'x', timeoutMs: 200 }), { kind: 'timeout' });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  assert.deepEqual(await runNudge({ script: path.join(dir, 'slow.sh'), mode: 'dry', team: 't', agent: 'a', text: 'x', timeoutMs: 10_000, signal: controller.signal }), { kind: 'cancelled' });
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
  assert.doesNotMatch(wrapper, /--machine|\bssh\b|send-keys|\btmux\b|\bherdr\b|send\.sh|\/poke\.sh/);
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
import { nudgeTimeoutFor, chosenAgmsgd, ineligibleReason, readDeliveryModeStrict, resolveBash, toNativeWindowsPath, toPosixScriptPath } from '../scripts/daemon/channels/antigravity-nudge.mjs';

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
  assert.deepEqual(result, { kind: 'timeout' });
  assert.ok(killed.length >= 1 && Number.isInteger(killed[0]));
});

test('a nudge gets a longer bound on Windows (about 10 s there), still under the 30 s channel deadline', () => {
  assert.equal(nudgeTimeoutFor('linux'), 10_000);
  assert.equal(nudgeTimeoutFor('darwin'), 10_000);
  assert.equal(nudgeTimeoutFor('win32'), 25_000);
  assert.ok(nudgeTimeoutFor('win32') < 30_000);
});
