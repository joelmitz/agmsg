// Pins the behaviour of the places where agmsgd names a channel or an agent
// type directly (the default channel list, the seat-table prefix, the seat
// inventory `status` prints). They describe what Claude Code and Codex
// already get, so adding another channel can be shown not to change it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { openInstallDb } from '../scripts/daemon/db.mjs';
import { createDefaultChannels } from '../scripts/daemon/main.mjs';
import { createSeatPoller } from '../scripts/daemon/seat-poll.mjs';
import { createSeatBook } from '../scripts/daemon/seat-book.mjs';
import { bootId } from '../scripts/daemon/executor.mjs';
import { ensureCodexChannelSchema } from '../scripts/daemon/channels/codex-queue-store.mjs';
import { ensureClaudeCodeChannelSchema } from '../scripts/daemon/channels/claude-code-queue-store.mjs';

const statusScript = fileURLToPath(new URL('../scripts/daemon/status.mjs', import.meta.url));

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agmsgd-seams-'));
  mkdirSync(path.join(root, 'run'));
  const db = openInstallDb(path.join(root, 'run', 'install.db'));
  ensureCodexChannelSchema(db);
  ensureClaudeCodeChannelSchema(db);
  t.after(() => { try { db.close(); } catch { /* a test may close it first */ } rmSync(root, { recursive: true, force: true }); });
  return { root, db };
}

test('the default channels start with Codex then Claude Code', async (t) => {
  const { root, db } = fixture(t);
  const channels = createDefaultChannels({ db, installRoot: root, expectedOpGen: 0 });
  t.after(() => Promise.all(channels.map(channel => channel.stop())));
  assert.deepEqual(channels.slice(0, 2).map(channel => channel.name), ['codex', 'claude-code']);
  for (const channel of channels) {
    assert.equal(typeof channel.pollOnce, 'function');
    assert.equal(typeof channel.stop, 'function');
  }
});

test('the seat poller reads the seat book of its own channel', (t) => {
  const { db } = fixture(t);
  const events = [];
  for (const channel of ['codex', 'claude-code']) {
    const book = createSeatBook();
    const poller = createSeatPoller({ db, book, installRoot: '/unused', channel, saveTimeout() {}, log: line => events.push(JSON.parse(line)) });
    poller.changeState('["t","a"]', () => book.set('["t","a"]', { state: 'blocked', reason: 'why' }));
  }
  assert.deepEqual(events.map(({ event, channel, state, reason }) => ({ event, channel, state, reason })), [
    { event: 'seat_state', channel: 'codex', state: 'blocked', reason: 'why' },
    { event: 'seat_state', channel: 'claude-code', state: 'blocked', reason: 'why' },
  ]);
});

test('status prints the Claude Code and Codex seat inventory as before', async (t) => {
  const { root, db } = fixture(t);
  const at = new Date().toISOString();
  const claude = [
    { seat: '["t","a"]', messaging_socket: '/s.sock', state: 'addressable', reason: '', since: at },
    { seat: '["t","b"]', messaging_socket: null, state: 'unaddressable', reason: 'role_session_missing', since: at },
  ];
  const codex = [{ seat: '["t","c"]', thread: null, codex_home: null, state: 'blocked', reason: 'x', since: at }];
  // Seat state lives only in the running agmsgd's memory, so a stand-in daemon
  // (own process: the status command blocks this one) answers `seats`.
  const socket = path.join(root, 'run/d.sock');
  const child = spawn(process.execPath, ['-e', `
    const net = require('node:net');
    const [socket, payload] = process.argv.slice(1);
    const { claude_code, codex } = JSON.parse(payload);
    net.createServer((c) => { let b = '';
      c.on('data', (d) => { b += d; let i;
        while ((i = b.indexOf('\\n')) >= 0) { const msg = JSON.parse(b.slice(0, i)); b = b.slice(i + 1);
          if (msg.type === 'hello') c.write(JSON.stringify({ type: 'hello_ok' }) + '\\n');
          else if (msg.type === 'status') { c.write(JSON.stringify({ type: 'status', ok: true }) + '\\n'); c.end(); }
          else if (msg.type === 'seats') { c.write(JSON.stringify({ type: 'seats', codex: { polled: true, seats: codex }, claude_code: { polled: true, seats: claude_code } }) + '\\n'); c.end(); } } });
    }).listen(socket, () => console.log('up'));
  `, socket, JSON.stringify({ claude_code: claude, codex })], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => child.kill());
  await new Promise(resolve => child.stdout.once('data', resolve));
  db.prepare("UPDATE daemon_owner SET state='ready', socket=?, executor_pid=?, executor_boot_id=?").run(socket, child.pid, bootId());
  db.prepare("UPDATE daemon_intent SET desired='on'").run();
  db.close();
  const run = (...flags) => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', statusScript, root, ...flags]);
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.on('error', reject);
    p.on('close', () => resolve(out));
  });
  const text = await run();
  assert.match(text, /^Claude Code t\/a: last daemon observation: addressable$/m);
  assert.match(text, /Claude Code seats: 1 unavailable destination records hidden/);
  assert.doesNotMatch(text, /t\/b/);
  assert.match(await run('--all'), /^Claude Code t\/b: last daemon observation: unaddressable \(role_session_missing\)$/m);
  const json = JSON.parse(await run('--json'));
  assert.equal(json.claude_code_seats.state, 'ok');
  assert.equal(json.claude_code_seats.seats.length, 2);
  assert.deepEqual(json.codex_seats.seats.map(seat => [seat.seat, seat.state, seat.reason]), [['["t","c"]', 'blocked', 'x']]);
  assert.deepEqual(json.codex_pending, []);
  assert.deepEqual(json.codex_expired, []);
});
