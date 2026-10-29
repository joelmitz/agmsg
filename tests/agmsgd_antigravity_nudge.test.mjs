// The Antigravity nudge channel: dry-run by default, live only behind a second
// switch, and only for a seat that passes all four conditions. A fake tmux
// records every call, so "nothing was typed" is checked against what the pane
// manager actually received.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, symlinkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
