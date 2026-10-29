// Pins the behaviour of the places where agmsgd names a channel or an agent
// type directly (the default channel list, the seat-table prefix, the seat
// inventory `status` prints). They describe what Claude Code and Codex
// already get, so adding another channel can be shown not to change it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { openInstallDb } from '../scripts/daemon/db.mjs';
import { createDefaultChannels } from '../scripts/daemon/main.mjs';
import { createSeatPoller } from '../scripts/daemon/seat-poll.mjs';
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

test('the seat poller reads the seat table of its own channel', (t) => {
  const { db } = fixture(t);
  const at = new Date().toISOString();
  const events = [];
  for (const [channel, table] of [['codex', 'beta_codex_seat'], ['claude-code', 'beta_claude_seat']]) {
    const poller = createSeatPoller({ db, installRoot: '/unused', channel, saveTimeout() {}, log: line => events.push(JSON.parse(line)) });
    poller.changeState('["t","a"]', () => {
      db.prepare(`INSERT INTO ${table} (seat, state, reason, checked_at) VALUES (?, 'blocked', 'why', ?)`).run('["t","a"]', at);
    });
  }
  assert.deepEqual(events.map(({ event, channel, state, reason }) => ({ event, channel, state, reason })), [
    { event: 'seat_state', channel: 'codex', state: 'blocked', reason: 'why' },
    { event: 'seat_state', channel: 'claude-code', state: 'blocked', reason: 'why' },
  ]);
});

test('status prints the Claude Code and Codex seat inventory as before', (t) => {
  const { root, db } = fixture(t);
  const at = new Date().toISOString();
  db.prepare("INSERT INTO beta_claude_seat (seat, messaging_socket, state, reason, checked_at) VALUES ('[\"t\",\"a\"]', '/s.sock', 'addressable', '', ?)").run(at);
  db.prepare("INSERT INTO beta_claude_seat (seat, messaging_socket, state, reason, checked_at) VALUES ('[\"t\",\"b\"]', NULL, 'unaddressable', 'role_session_missing', ?)").run(at);
  db.prepare("INSERT INTO beta_codex_seat (seat, thread, codex_home, state, reason, checked_at) VALUES ('[\"t\",\"c\"]', NULL, NULL, 'blocked', 'x', ?)").run(at);
  db.close();
  const run = (...flags) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', statusScript, root, ...flags], { encoding: 'utf8' });
  const text = run();
  assert.match(text, /^Claude Code t\/a: last daemon observation: addressable$/m);
  assert.match(text, /Claude Code seats: 1 unavailable destination records hidden/);
  assert.doesNotMatch(text, /t\/b/);
  assert.match(run('--all'), /^Claude Code t\/b: last daemon observation: unaddressable \(role_session_missing\)$/m);
  const json = JSON.parse(run('--json'));
  assert.equal(json.claude_code_seats.state, 'ok');
  assert.equal(json.claude_code_seats.seats.length, 2);
  assert.deepEqual(json.codex_seats.seats.map(seat => [seat.seat, seat.state, seat.reason]), [['["t","c"]', 'blocked', 'x']]);
  assert.deepEqual(json.codex_pending, []);
  assert.deepEqual(json.codex_expired, []);
});
