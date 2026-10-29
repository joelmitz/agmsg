// The Antigravity observation channel: off by default, records what it sees for
// `agmsg daemon status`, and writes nothing outside its own status table.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openInstallDb } from '../scripts/daemon/db.mjs';
import { createDefaultChannels, pollChannelHooks } from '../scripts/daemon/main.mjs';
import { ensureCodexChannelSchema } from '../scripts/daemon/channels/codex-queue-store.mjs';
import { ensureClaudeCodeChannelSchema } from '../scripts/daemon/channels/claude-code-queue-store.mjs';
import { classifySeat, createAntigravityObserveChannel, readSupervisor } from '../scripts/daemon/channels/antigravity-observe.mjs';

const statusScript = fileURLToPath(new URL('../scripts/daemon/status.mjs', import.meta.url));
const moduleSource = fileURLToPath(new URL('../scripts/daemon/channels/antigravity-observe.mjs', import.meta.url));
const START = '123456';

function fixture(t, { marker = true } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agmsgd-agy-observe-'));
  const project = path.join(root, 'project');
  mkdirSync(path.join(root, 'run'));
  mkdirSync(path.join(root, 'db'));
  mkdirSync(path.join(root, 'teams', 'test'), { recursive: true });
  mkdirSync(path.join(project, '.agent', 'rules'), { recursive: true });
  writeFileSync(path.join(root, 'teams', 'test', 'config.json'), JSON.stringify({ agents: {
    agy: { registrations: [{ type: 'antigravity', project }] },
    other: { registrations: [{ type: 'claude-code', project }] },
  } }));
  if (marker) writeFileSync(path.join(project, '.agent', 'rules', 'agmsg.md'), '<!-- agmsg:antigravity:monitor -->\n# agmsg Integration Rule\n');
  const store = new DatabaseSync(path.join(root, 'db', 'messages.db'));
  store.exec(`
    CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, team TEXT, to_agent TEXT, id TEXT, agent TEXT, msg_id TEXT, legacy_id INTEGER);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, team TEXT, to_agent TEXT, read_at TEXT);
    CREATE TABLE read_cursors (team TEXT, agent TEXT, local_position INTEGER);
    INSERT INTO events (type, team, to_agent, id) VALUES ('message_sent', 'test', 'agy', 'm1');`);
  store.close();
  // A supervisor record as the TUI supervisor writes it.
  const stateFile = path.join(root, 'run', 'antigravity-tui-pty.test__agy.state.json');
  writeFileSync(stateFile, JSON.stringify({ team: 'test', role: 'agy', supervisorPhase: 'WAITING_FOR_IDLE', humanInputActive: false, manualResumeRequired: false, durableAttention: false, batch: null }));
  writeFileSync(path.join(root, 'run', 'read-reservation.test__agy.json'), JSON.stringify({ type: 'antigravity', kind: 'tui-pty', pid: 4242, start: START, state: stateFile }));
  const db = openInstallDb(path.join(root, 'run', 'install.db'));
  ensureCodexChannelSchema(db);
  ensureClaudeCodeChannelSchema(db);
  const live = { start: START };
  const logs = [];
  const channel = createAntigravityObserveChannel({
    db, installRoot: root, log: line => logs.push(line), procStart: () => live.start,
  });
  const enable = () => writeFileSync(path.join(root, 'run', 'observe-antigravity'), '');
  t.after(async () => { await channel.stop(); try { db.close(); } catch { /* closed by the test */ } rmSync(root, { recursive: true, force: true }); });
  return { root, project, db, channel, live, enable, stateFile, logs };
}

const seat = db => db.prepare("SELECT seat, state, reason, detail FROM beta_antigravity_seat WHERE seat = '[\"test\",\"agy\"]'").get();

// Content hash and mtime of every file under root, except the daemon's own
// install.db family and log (its status table and a log line are the only
// things the channel may write).
function snapshot(root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { out[`${path.relative(root, full)}/`] = ''; walk(full); continue; }
      const rel = path.relative(root, full);
      if (/^run\/(install\.db.*|agmsgd\.log)$/.test(rel)) continue;
      out[rel] = `${createHash('sha256').update(readFileSync(full)).digest('hex')}@${statSync(full).mtimeMs}`;
    }
  };
  walk(root);
  return out;
}

function otherTables(db) {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'beta_antigravity_seat' ORDER BY name").all().map(row => row.name);
  return Object.fromEntries(names.map(name => [name, db.prepare(`SELECT * FROM ${name}`).all()]));
}

test('off by default: a poll touches nothing and creates no table', async (t) => {
  const { root, db, channel } = fixture(t);
  const before = [snapshot(root), otherTables(db)];
  await channel.pollOnce();
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='beta_antigravity_seat'").get().n, 0);
  assert.deepEqual([snapshot(root), otherTables(db)], before);
});

test('off by default in status: no text and enabled:false in JSON', (t) => {
  const { root, db } = fixture(t);
  db.close();
  const run = (...flags) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', statusScript, root, ...flags], { encoding: 'utf8' });
  assert.doesNotMatch(run(), /Antigravity/);
  assert.deepEqual(JSON.parse(run('--json')).antigravity_observe, { enabled: false, state: 'disabled', seats: [] });
});

test('a symlinked flag does not enable it', async (t) => {
  const { root, db, channel } = fixture(t);
  writeFileSync(path.join(root, 'flag-target'), '');
  symlinkSync(path.join(root, 'flag-target'), path.join(root, 'run', 'observe-antigravity'));
  await channel.pollOnce();
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='beta_antigravity_seat'").get().n, 0);
});

test('enabled: a running monitor seat is observed with mode, supervisor and phase', async (t) => {
  const { db, channel, enable } = fixture(t);
  enable();
  await channel.pollOnce();
  const row = seat(db);
  assert.equal(row.state, 'observed');
  assert.equal(row.reason, 'monitor_running');
  assert.deepEqual(JSON.parse(row.detail), { mode: 'monitor', supervisor: 'running', kind: 'tui-pty', phase: 'WAITING_FOR_IDLE', paused: false, attention: false });
  // Only agy registrations are seats; the claude-code role in the same team is not.
  assert.equal(db.prepare('SELECT count(*) AS n FROM beta_antigravity_seat').get().n, 1);
});

test('enabled: status shows the seat, and says agmsgd does not deliver', async (t) => {
  const { root, db, channel, enable } = fixture(t);
  enable();
  await channel.pollOnce();
  db.close();
  const run = (...flags) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', statusScript, root, ...flags], { encoding: 'utf8' });
  assert.match(run(), /^Antigravity test\/agy: observation only, agmsgd does not deliver here: monitor_running \(mode monitor, supervisor running, phase WAITING_FOR_IDLE\)$/m);
  const json = JSON.parse(run('--json')).antigravity_observe;
  assert.equal(json.enabled, true);
  assert.equal(json.seats[0].reason, 'monitor_running');
});

test('enabled before the daemon has polled: status says so instead of showing nothing', (t) => {
  const { root, db, enable } = fixture(t);
  enable();
  db.close();
  const text = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', statusScript, root], { encoding: 'utf8' });
  assert.match(text, /Antigravity observation is on, but the daemon has not recorded a poll yet/);
});

test('what the seat shows follows the supervisor and the rule file', async (t) => {
  const { db, channel, live, enable, project, stateFile } = fixture(t);
  enable();
  live.start = '999';
  await channel.pollOnce();
  assert.equal(seat(db).reason, 'monitor_not_running');
  live.start = undefined;
  await channel.pollOnce();
  assert.equal(seat(db).reason, 'monitor_liveness_unknown');
  live.start = START;
  writeFileSync(stateFile, JSON.stringify({ team: 'test', role: 'agy', supervisorPhase: 'WAITING_FOR_IDLE', humanInputActive: true, batch: { phase: 'prepared', messages: [{ id: 'secret-id' }] } }));
  await channel.pollOnce();
  assert.equal(seat(db).reason, 'monitor_paused');
  assert.deepEqual([JSON.parse(seat(db).detail).batch, seat(db).detail.includes('secret-id')], ['prepared', false]);
  writeFileSync(stateFile, JSON.stringify({ team: 'test', role: 'agy', supervisorPhase: 'NEEDS_ATTENTION', durableAttention: true, batch: { phase: 'uncertain' } }));
  await channel.pollOnce();
  assert.equal(seat(db).reason, 'monitor_needs_attention');
  writeFileSync(path.join(project, '.agent', 'rules', 'agmsg.md'), '# agmsg Integration Rule\n');
  await channel.pollOnce();
  assert.equal(seat(db).reason, 'turn_mode');
  rmSync(path.join(project, '.agent', 'rules', 'agmsg.md'));
  await channel.pollOnce();
  assert.equal(seat(db).reason, 'no_delivery_mode');
});

test('a reservation that names a state file outside run/ is not followed', (t) => {
  const { root } = fixture(t);
  const outside = path.join(root, 'outside.json');
  writeFileSync(outside, JSON.stringify({ team: 'test', role: 'agy', supervisorPhase: 'LEAKED' }));
  writeFileSync(path.join(root, 'run', 'read-reservation.test__agy.json'), JSON.stringify({ type: 'antigravity', kind: 'tui-pty', pid: 1, start: START, state: outside }));
  const seen = readSupervisor(path.join(root, 'run'), 'test', 'agy', () => START);
  assert.equal(seen.phase, undefined);
  assert.equal(seen.presence, 'present');
});

test('classifySeat is a pure mapping', () => {
  assert.deepEqual(classifySeat({ mode: 'none', supervisor: { presence: 'absent' } }), { state: 'observed', reason: 'no_delivery_mode', detail: { mode: 'none', supervisor: 'absent' } });
});

test('the message store is never opened: a missing or broken store changes nothing about the observation', async (t) => {
  const a = fixture(t);
  a.enable();
  rmSync(path.join(a.root, 'db', 'messages.db'));
  await a.channel.pollOnce();
  assert.equal(seat(a.db).reason, 'monitor_running');
  writeFileSync(path.join(a.root, 'db', 'messages.db'), 'not a database');
  await a.channel.pollOnce();
  assert.equal(seat(a.db).reason, 'monitor_running');
});

// Listing of a directory tree: names, sizes and mtimes (an empty file set is a result too).
function listing(dir) {
  return readdirSync(dir, { withFileTypes: true }).map(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? `${entry.name}/` : `${entry.name}:${statSync(full).size}:${statSync(full).mtimeMs}`;
  }).sort();
}

for (const variant of ['wal-no-aux-files', 'wal-with-wal-and-shm', 'wal-with-wal-only', 'wal-with-shm-only', 'rollback-journal']) {
  test(`message store variant ${variant}: no file is created or changed in the store directory`, async (t) => {
    const { root, channel, enable } = fixture(t);
    const dir = path.join(root, 'db');
    rmSync(path.join(dir, 'messages.db'));
    const store = new DatabaseSync(path.join(dir, 'messages.db'));
    store.exec(variant === 'rollback-journal' ? 'PRAGMA journal_mode=DELETE' : 'PRAGMA journal_mode=WAL');
    store.exec('CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT); INSERT INTO events (type) VALUES (\'message_sent\')');
    if (variant === 'wal-no-aux-files') store.close();
    if (variant === 'wal-with-wal-only' || variant === 'wal-with-shm-only') {
      // Keep one auxiliary file by hand: close cleanly, then recreate it.
      store.close();
      writeFileSync(path.join(dir, variant === 'wal-with-wal-only' ? 'messages.db-wal' : 'messages.db-shm'), '');
    }
    t.after(() => { try { store.close(); } catch { /* already closed */ } });
    enable();
    const before = listing(dir);
    for (let i = 0; i < 3; i += 1) await channel.pollOnce();
    assert.deepEqual(listing(dir), before);
  });
}

test('a symlink anywhere in the path to the state file cannot lead the read outside run/', (t) => {
  const { root } = fixture(t);
  const outside = path.join(root, 'outside');
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'state.json'), JSON.stringify({ team: 'test', role: 'agy', supervisorPhase: 'OUTSIDE_RUN' }));
  symlinkSync(outside, path.join(root, 'run', 'nested'));
  writeFileSync(path.join(root, 'run', 'read-reservation.test__agy.json'), JSON.stringify({ type: 'antigravity', kind: 'tui-pty', pid: 1, start: START, state: path.join(root, 'run', 'nested', 'state.json') }));
  const seen = readSupervisor(path.join(root, 'run'), 'test', 'agy', () => START);
  assert.equal(seen.phase, undefined);
  assert.equal(seen.presence, 'present');
  // A run/ that is itself reached through a link still works for files that really are inside it.
  const link = path.join(root, 'run-link');
  symlinkSync(path.join(root, 'run'), link);
  writeFileSync(path.join(root, 'run', 'read-reservation.test__agy.json'), JSON.stringify({ type: 'antigravity', kind: 'tui-pty', pid: 1, start: START, state: path.join(link, 'antigravity-tui-pty.test__agy.state.json') }));
  assert.equal(readSupervisor(link, 'test', 'agy', () => START).phase, 'WAITING_FOR_IDLE');
});

test('a record that cannot be read or checked is "liveness unknown", never "not running"', async (t) => {
  const { root, db, channel, live, enable } = fixture(t);
  enable();
  writeFileSync(path.join(root, 'run', 'read-reservation.test__agy.json'), '{ broken');
  await channel.pollOnce();
  assert.equal(seat(db).reason, 'monitor_liveness_unknown');
  assert.equal(JSON.parse(seat(db).detail).supervisor, 'unreadable');
  rmSync(path.join(root, 'run', 'read-reservation.test__agy.json'));
  await channel.pollOnce();
  assert.equal(seat(db).reason, 'monitor_not_running');
  assert.equal(live.start, START);
});

test('an exception that carries a path or free text never reaches the status table or the log', async (t) => {
  const { root, db, logs, enable } = fixture(t);
  enable();
  const secret = path.join(root, 'private-path-SECRET');
  const make = (extra) => createAntigravityObserveChannel({ db, installRoot: root, log: line => logs.push(line), procStart: () => START, ...extra });
  const throwing = Object.assign(new Error(`ENOENT: no such file '${secret}'`), { code: 'ENOENT' });
  const odd = Object.assign(new Error(`free text ${secret}`), { code: `weird ${secret}` });
  for (const [extra, expected] of [
    [{ procStart: () => { throw throwing; } }, 'observe_failed:ENOENT'],
    [{ procStart: () => { throw odd; } }, 'observe_failed'],
    [{ listSeats: () => { throw odd; } }, null],
  ]) {
    const channel = make(extra);
    await channel.pollOnce();
    await channel.stop();
    if (expected) assert.equal(seat(db).reason, expected);
  }
  const everything = JSON.stringify([db.prepare('SELECT * FROM beta_antigravity_seat').all(), logs]);
  assert.doesNotMatch(everything, /SECRET|free text|private-path/);
});

test('a seat that is no longer registered is dropped; turning the flag off stops updates', async (t) => {
  const { root, db, channel, enable } = fixture(t);
  enable();
  await channel.pollOnce();
  writeFileSync(path.join(root, 'teams', 'test', 'config.json'), JSON.stringify({ agents: { agy: { registrations: [{ type: 'claude-code', project: root }] } } }));
  await channel.pollOnce();
  assert.equal(db.prepare('SELECT count(*) AS n FROM beta_antigravity_seat').get().n, 0);
  writeFileSync(path.join(root, 'teams', 'test', 'config.json'), JSON.stringify({ agents: { agy: { registrations: [{ type: 'antigravity', project: root }] } } }));
  await channel.pollOnce();
  assert.equal(db.prepare('SELECT count(*) AS n FROM beta_antigravity_seat').get().n, 1);
  rmSync(path.join(root, 'run', 'observe-antigravity'));
  const before = db.prepare('SELECT * FROM beta_antigravity_seat').all();
  await new Promise(resolve => setTimeout(resolve, 5));
  await channel.pollOnce();
  assert.deepEqual(db.prepare('SELECT * FROM beta_antigravity_seat').all(), before);
});

test('writes nothing but its own status table: files, message store and other tables are byte-identical', async (t) => {
  const { root, db, channel, enable } = fixture(t);
  // Stand-ins for every way a write could reach an agent: a pane driver and agy itself.
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  for (const name of ['herdr', 'tmux', 'orca', 'agy', 'agmsg', 'python3']) {
    writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${root}/called"\n`);
    chmodSync(path.join(bin, name), 0o755);
  }
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath}`;
  t.after(() => { process.env.PATH = savedPath; });
  enable();
  await channel.pollOnce();
  const before = [snapshot(root), otherTables(db)];
  for (let i = 0; i < 3; i += 1) await channel.pollOnce();
  assert.deepEqual([snapshot(root), otherTables(db)], before);
  assert.equal(existsSync(path.join(root, 'called')), false, 'no pane driver or agy command was run');
  assert.equal(existsSync(path.join(root, 'db', 'messages.db-wal')) || existsSync(path.join(root, 'db', 'messages.db-journal')), false);
});

test('the channel has no way to send: its surface and its source', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agmsgd-agy-surface-'));
  mkdirSync(path.join(root, 'run'));
  const db = openInstallDb(path.join(root, 'run', 'install.db'));
  try {
    const channel = createAntigravityObserveChannel({ db, installRoot: root });
    assert.deepEqual(Object.keys(channel).sort(), ['name', 'pollOnce', 'stop']);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  const source = readFileSync(moduleSource, 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(source, /child_process|node:net|node:http|node:dgram|node:worker_threads/);
  assert.doesNotMatch(source, /\b(writeFile|writeFileSync|appendFile|appendFileSync|rename|renameSync|unlink|unlinkSync|rm|rmSync|mkdir|mkdirSync|openSync|writeSync|chmod|utimes|truncate|copyFile|symlink)\b/);
  assert.doesNotMatch(source, /\b(poke|nudge|send-keys|safe-poke|inboxNudge)\b/);
});

test('the default daemon channels include the Antigravity channels last, and the daemon poll path records the seat only when enabled', async (t) => {
  const { root, db, enable } = fixture(t);
  // The default channel reads its storage location from the environment.
  const saved = { AGMSG_STORAGE_PATH: process.env.AGMSG_STORAGE_PATH, AGMSG_CONFIG: process.env.AGMSG_CONFIG };
  process.env.AGMSG_STORAGE_PATH = path.join(root, 'db');
  process.env.AGMSG_CONFIG = path.join(root, 'config.json');
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const channels = createDefaultChannels({ db, installRoot: root, expectedOpGen: 0 });
  t.after(() => Promise.all(channels.map(channel => channel.stop())));
  assert.deepEqual(channels.map(channel => channel.name), ['codex', 'claude-code', 'antigravity-observe', 'antigravity-nudge']);
  await pollChannelHooks(channels, () => {}, { installRoot: root });
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='beta_antigravity_seat'").get().n, 0);
  enable();
  await pollChannelHooks(channels, () => {}, { installRoot: root });
  assert.equal(seat(db).reason === 'monitor_running' || seat(db).reason === 'monitor_not_running' || seat(db).reason === 'monitor_liveness_unknown', true);
});
