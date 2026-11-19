// Codex の「記録 -> 配送」を、実スクリプトと実チャンネルで通して確かめる。
//
//   plain Codex 起動 -> 記録スクリプト(thread + 絶対パス codex_home)
//     -> run/role-session.<team>__<agent> -> agmsgd の codex チャンネルが読む
//     -> `codex queue --thread <T> --message ...` を CODEX_HOME=<記録値> で実行
//
// 記録を書くのは codex-record-session.sh と SessionStart hook、読んで配送するのは
// createCodexQueueChannel の実物。codex の実体だけを fake に差し替える。
//
// 隔離: このファイルは、wrapper(test_agmsgd_codex_record_delivery.bats)が作った
// 一時ディレクトリの中だけで動く。実 HOME・既存の設定・実 agmsg には触れない。
// 起動直後のガード(許可リスト方式)が満たされなければ、何も作らずに失敗する。
// プロセスへ signal は一切送らない(存在確認の signal 0 だけ)。

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, closeSync, cpSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  realpathSync, writeFileSync, writeSync, constants as fsConstants,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') {
  // POSIX のプロセスグループと mkfifo を前提にする。ガードより前に判定する(何にも触れない)。
  test('Codex record-to-delivery chain', { skip: 'POSIX process groups and mkfifo are required' }, () => {});
} else {
  await main();
}

async function main() {
  // ---- 隔離のガード(検査だけ。ファイル・ディレクトリを作らない・消さない) ----
  const HOW = '`bats tests/test_agmsgd_codex_record_delivery.bats` で実行すること';
  const fail = (item, message) => {
    throw new Error(`isolation guard (item ${item}): ${message}. ${HOW}`);
  };
  const strictlyUnder = (root, target) => {
    const relative = path.relative(root, target);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  };
  const real = (item, p, what) => {
    try { return realpathSync(p); } catch (error) { return fail(item, `${what} (${p}) cannot be resolved: ${error.code ?? error.message}`); }
  };

  const R = process.env.AGMSG_TEST_ISOLATION_ROOT;
  const P = process.env.AGMSG_TEST_ISOLATION_PARENT;
  const T = process.env.AGMSG_TEST_ISOLATION_TOKEN;
  // 1. 検証材料
  for (const [name, value] of [['AGMSG_TEST_ISOLATION_ROOT', R], ['AGMSG_TEST_ISOLATION_PARENT', P], ['AGMSG_TEST_ISOLATION_TOKEN', T]]) {
    if (!value) fail(1, `${name} is not set (this file must be started by its bats wrapper)`);
  }
  if (!path.isAbsolute(R) || !path.isAbsolute(P)) fail(1, 'the isolation root and its parent must be absolute paths');
  // 2. R の実体
  let rootStat;
  try { rootStat = lstatSync(R); } catch (error) { fail(2, `the isolation root cannot be inspected: ${error.code}`); }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail(2, 'the isolation root is not a plain directory');
  if (real(2, R, 'the isolation root') !== R) fail(2, 'the isolation root path contains a symlink');
  // 3. R の名前と場所
  if (!/^agmsg-codex-record-delivery\.[A-Za-z0-9]{8,}$/.test(path.basename(R))) fail(3, 'the isolation root name is not the wrapper\'s mktemp form');
  if (path.dirname(R) !== real(3, P, 'the isolation parent')) fail(3, 'the isolation root is not directly under its parent');
  // 4. 所有者とモード
  if (rootStat.uid !== process.getuid()) fail(4, 'the isolation root is not owned by the current user');
  if ((rootStat.mode & 0o777) !== 0o700) fail(4, 'the isolation root mode is not 0700');
  // 5. 既存の場所でないこと(許可リストの核)
  let passwdHome;
  try { passwdHome = os.userInfo().homedir; } catch (error) { fail(5, `os.userInfo() is unavailable (${error.message}); failing closed`); }
  const forbidden = ['/', '/home', '/tmp', '/var/tmp', P, passwdHome, process.env.HOME].filter(Boolean);
  for (const place of forbidden) {
    let resolved;
    try { resolved = realpathSync(place); } catch { continue; }
    if (resolved === R) fail(5, `the isolation root is ${place}`);
  }
  if (strictlyUnder(R, real(5, passwdHome, 'the passwd home'))) fail(5, 'the isolation root is an ancestor of the home directory');
  const allowedEntries = new Set(['.isolation-owner', 'home', 'xdg', 'tmp']);
  for (const entry of readdirSync(R)) {
    if (!allowedEntries.has(entry)) fail(5, `the isolation root already contains ${entry}`);
  }
  // 6. 所有マーカー
  const markerPath = path.join(R, '.isolation-owner');
  let marker;
  try { marker = lstatSync(markerPath); } catch (error) { fail(6, `the ownership marker cannot be inspected: ${error.code}`); }
  if (!marker.isFile() || marker.isSymbolicLink() || marker.uid !== process.getuid() || (marker.mode & 0o777) !== 0o600 || marker.nlink !== 1) {
    fail(6, 'the ownership marker is not a plain 0600 file owned by the current user with one link');
  }
  if (readFileSync(markerPath, 'utf8').trim() !== T) fail(6, 'the ownership marker does not match the token');
  // 7. HOME・TMPDIR・XDG の位置(7 つすべて。未設定を許さない)
  const LOCATION_VARS = ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR'];
  const checkedLocation = (item, name, value) => {
    if (!value) fail(item, `${name} is not set`);
    if (!path.isAbsolute(value)) fail(item, `${name} is not absolute`);
    let stat;
    try { stat = lstatSync(value); } catch (error) { fail(item, `${name} cannot be inspected: ${error.code}`); }
    const resolved = real(item, value, name);
    if (!stat.isDirectory() && !(stat.isSymbolicLink() && lstatSync(resolved).isDirectory())) fail(item, `${name} is not a directory`);
    if (!strictlyUnder(R, resolved)) fail(item, `${name} is not strictly inside the isolation root`);
    if (resolved !== path.resolve(value)) fail(item, `${name} contains a symlink`);
    return resolved;
  };
  for (const name of LOCATION_VARS) checkedLocation(7, name, process.env[name]);
  if ((lstatSync(process.env.XDG_RUNTIME_DIR).mode & 0o777) !== 0o700) fail(7, 'XDG_RUNTIME_DIR is not 0700');
  // 8. node 自身の見え方
  if (os.homedir() !== process.env.HOME) fail(8, 'os.homedir() does not match HOME');
  if (!strictlyUnder(R, real(8, os.tmpdir(), 'os.tmpdir()'))) fail(8, 'os.tmpdir() is not inside the isolation root');
  // 9. 持ち込まないもの
  for (const name of ['CODEX_HOME', 'AGMSG_CODEX_HOME', 'ORCA_CODEX_HOME', 'AGMSG_CONFIG', 'AGMSG_STORAGE_PATH', 'CODEX_THREAD_ID',
    'CODEX_SESSION_ID', 'AGMSG_SESSION_ID', 'AGMSG_ROLE_SESSION_CODEX_HOME']) {
    if (name in process.env) fail(9, `${name} is present in the process environment`);
  }

  // ---- ここから先は、ガードを通った後 ----
  // 存在しないパスも検査する: 存在する最も近い祖先を realpath し、残りの成分に .. を許さない。
  const underRoot = (p) => {
    if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error(`path is not absolute: ${p}`);
    const normalized = path.resolve(p);
    let ancestor = normalized;
    const rest = [];
    for (;;) {
      try { lstatSync(ancestor); break; } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        rest.unshift(path.basename(ancestor));
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw new Error(`no existing ancestor for ${p}`);
        ancestor = parent;
      }
    }
    const resolved = realpathSync(ancestor);
    if (resolved !== ancestor) throw new Error(`path goes through a symlink: ${p}`);
    if (resolved !== R && !strictlyUnder(R, resolved)) throw new Error(`path is outside the isolation root: ${p}`);
    if (rest.includes('..')) throw new Error(`path has a parent component: ${p}`);
    return normalized;
  };

  const repo = fileURLToPath(new URL('../', import.meta.url));
  const { openInstallDb } = await import('../scripts/daemon/db.mjs');
  const { ensureCodexChannelSchema } = await import('../scripts/daemon/channels/codex-queue-store.mjs');
  const { createCodexQueueChannel } = await import('../scripts/daemon/channels/codex-queue.mjs');
  const { processStartWitness } = await import('../scripts/daemon/channels/process-group.mjs');

  const thread = '01a13352-3599-7d62-a149-4c8182bcf008';
  const olderThread = '01a13352-3599-7d62-a149-4c8182bcf000';
  const hookThread = '01a13352-3599-7d62-a149-4c8182bcf009';
  const sandboxVars = LOCATION_VARS.filter((name) => name !== 'HOME');

  // 子プロセスの env は、この 1 関数だけで作る(許可リスト。継承しない)。
  function isolatedEnv(c, extra = {}, { home = c.home } = {}) {
    const env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
      HOME: home,
      ...Object.fromEntries(sandboxVars.map((name) => [name, process.env[name]])),
      AGMSG_CONFIG: c.config,
      AGMSG_STORAGE_PATH: c.store,
      ...extra,
    };
    for (const name of [...sandboxVars, 'HOME', 'AGMSG_CONFIG', 'AGMSG_STORAGE_PATH', 'CODEX_HOME']) {
      if (name === 'HOME' && env.HOME === '') continue; // 「HOME なし」の負の対照だけ
      if (env[name] !== undefined) underRoot(env[name]);
    }
    return env;
  }

  let caseNumber = 0;
  function caseRoot(name) {
    caseNumber += 1;
    const dir = underRoot(path.join(R, `case-${caseNumber}-${name}`));
    mkdirSync(dir, { mode: 0o700 });
    const c = {
      dir,
      home: path.join(dir, 'home'),
      proj: path.join(dir, 'proj'),
      store: path.join(dir, 'store'),
      config: path.join(dir, 'config.json'),
      calls: path.join(dir, 'calls.jsonl'),
      holderPid: path.join(dir, 'holder.pid'),
      fifo: path.join(dir, 'hold.fifo'),
      fake: path.join(dir, 'fake-codex'),
      run: path.join(dir, 'run'),
    };
    for (const p of Object.values(c)) underRoot(p);
    for (const d of [c.home, c.proj, c.store, c.run, path.join(dir, 'teams', 'alpha')]) mkdirSync(d, { recursive: true });
    cpSync(path.join(repo, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
    writeFileSync(c.config, JSON.stringify({ storage: 'sqlite' }));
    writeFileSync(path.join(dir, 'teams', 'alpha', 'config.json'), JSON.stringify({
      name: 'alpha',
      agents: {
        alice: { registrations: [{ type: 'codex', project: realpathSync(c.proj) }] },
        bob: { registrations: [{ type: 'claude-code', project: realpathSync(c.proj) }] },
      },
    }));
    writeFileSync(c.fake, fakeCodexSource(c), { mode: 0o755 });
    chmodSync(c.fake, 0o755);
    return c;
  }

  // codex の代役。引数・CODEX_HOME・自分で発行した受付 ID を記録し、queue の DB に項目を入れ、
  // チャンネルが読む 1 行を出して終了する。AGMSG_TEST_HOLD_FIFO があるときだけ、同じプロセス
  // グループに保持役の子孫を残す(FIFO の解放か 30 秒の自己終了で終わる。signal では終わらせない)。
  function fakeCodexSource(c) {
    return `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const args = process.argv.slice(2);
const itemId = crypto.randomUUID();
const thread = args[args.indexOf('--thread') + 1];
const home = process.env.CODEX_HOME;
const fifo = process.env.AGMSG_TEST_HOLD_FIFO;
if (fifo) {
  const holder = spawn(process.execPath, ['-e', ${JSON.stringify(`
    const fs = require('node:fs');
    fs.open(process.argv[1], 'r', () => process.exit(0));
    setTimeout(() => process.exit(0), 30000);
  `)}, fifo], { stdio: 'ignore' });
  fs.writeFileSync(${JSON.stringify(c.holderPid)}, String(holder.pid));
  holder.unref();
}
fs.appendFileSync(${JSON.stringify(c.calls)}, JSON.stringify({ args, codexHome: home ?? null, itemId }) + '\\n');
const db = new DatabaseSync(path.join(home, 'queue_1.sqlite'));
db.exec('CREATE TABLE IF NOT EXISTS queued_items (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, payload_json TEXT NOT NULL)');
db.prepare('INSERT INTO queued_items VALUES (?, ?, ?)').run(itemId, thread, JSON.stringify({ message: args[args.indexOf('--message') + 1] }));
db.close();
process.stdout.write('Queued message ' + itemId + ' for thread ' + thread + '.\\n');
`;
  }

  const sh = (c, script, args, extra = {}, options = {}) => execFileSync('bash', [path.join(c.dir, 'scripts', ...script.split('/')), ...args], {
    encoding: 'utf8', cwd: c.proj, env: isolatedEnv(c, extra, options), input: options.input, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const record = (c, extra = {}, options = {}) => sh(c, 'drivers/types/codex/codex-record-session.sh', ['alpha', 'alice', c.proj], extra, options);
  const roleFile = (c) => path.join(c.run, 'role-session.alpha__alice');
  const roleField = (c, name) => (readFileSync(roleFile(c), 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm')) ?? [])[1];

  // profile の系統。A: 既定 HOME($HOME/.codex)、B: 通常の CODEX_HOME。
  function profileFor(c, system) {
    if (system === 'A') {
      const profile = path.join(c.home, '.codex');
      mkdirSync(profile, { recursive: true });
      return { profile: realpathSync(profile), env: {} };
    }
    const profile = path.join(c.dir, 'profile-b');
    mkdirSync(profile, { recursive: true });
    assert.notEqual(realpathSync(profile), path.join(realpathSync(c.home), '.codex'));
    return { profile: realpathSync(profile), env: { CODEX_HOME: profile } };
  }

  function rollout(profile, id, c) {
    const dir = path.join(profile, 'sessions', '2026', '11', '18');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `rollout-2026-11-18T00-00-00-${id}.jsonl`), [
      JSON.stringify({ type: 'session_meta', payload: { id, cwd: realpathSync(c.proj) } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'an earlier prompt' } }), '',
    ].join('\n'));
  }

  function openChannel(t, c, options = {}) {
    const db = openInstallDb(path.join(c.run, 'install.db'));
    t.after(() => db.close());
    ensureCodexChannelSchema(db);
    db.prepare('UPDATE meta SET codex_path=?, node_path=?').run(c.fake, process.execPath);
    db.exec("UPDATE daemon_intent SET desired='on', op_gen=1");
    // now / queue / captureGroup / observeGroup と hostPlatform は差し替えない(実プロセスを観測させる)。
    const channel = createCodexQueueChannel({
      db, installRoot: c.dir, expectedOpGen: 1, executable: c.fake,
      env: isolatedEnv(c, options.env ?? {}),
    });
    t.after(() => channel.stop());
    return { db, channel };
  }

  const seatRow = (channel) => channel.seats().seats.find((row) => row.seat === JSON.stringify(['alpha', 'alice']));
  const calls = (c) => {
    try { return readFileSync(c.calls, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)); } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  };
  const queueRows = (db) => db.prepare('SELECT seat, codex_home, thread, queue_item_id, state, children FROM beta_codex_queue ORDER BY id').all();
  const sendMessage = (c) => sh(c, 'send.sh', ['alpha', 'bob', 'alice', 'secret body that must not appear in the nudge']);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function waitFor(condition, limitMs, describe) {
    const deadline = Date.now() + limitMs;
    for (;;) {
      const value = await condition();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`timed out after ${limitMs} ms: ${describe()}`);
      await sleep(20);
    }
  }

  const NUDGE = /^\[agmsg:[A-Za-z0-9-]+\] New messages are waiting\./;

  // 受付済みの状態を検査する(pending / confirmed のどちらでも成り立つ。expired・NULL は不合格)。
  function assertDelivered(t, c, db, channel, expectedHome, expectedThread) {
    const made = calls(c);
    assert.equal(made.length, 1, `queue was called ${made.length} times`);
    const [call] = made;
    assert.deepEqual(call.args.slice(0, 4), ['queue', '--thread', expectedThread, '--message']);
    assert.match(call.args[4], NUDGE);
    assert.ok(!call.args[4].includes('secret body'), 'the nudge must not carry the message body');
    assert.equal(call.codexHome, expectedHome, 'CODEX_HOME for the queue call is the recorded profile');
    const rows = queueRows(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].codex_home, expectedHome);
    assert.equal(rows[0].thread, expectedThread);
    assert.equal(rows[0].queue_item_id, call.itemId, 'the receipt the channel took is the one the fake issued');
    const queueDb = new DatabaseSync(path.join(expectedHome, 'queue_1.sqlite'), { readOnly: true });
    try {
      assert.equal(queueDb.prepare('SELECT count(*) AS n FROM queued_items WHERE id = ?').get(call.itemId).n, 1);
    } finally { queueDb.close(); }
    assert.equal(JSON.parse(rows[0].children).result, 'queued');
    assert.ok(['pending', 'confirmed'].includes(rows[0].state), `state ${rows[0].state}`);
    const seat = seatRow(channel);
    assert.equal(seat?.state, 'addressable', JSON.stringify(seat));
    t.diagnostic(`observed state after the first poll: ${rows[0].state}`);
    return rows[0].state;
  }

  async function assertNoDuplicate(c, db, channel) {
    await channel.pollOnce();
    assert.equal(calls(c).length, 1, 'a second poll must not nudge the same unread again');
    assert.equal(queueRows(db).length, 1);
  }

  // 経路ごとの記録の作り方。戻り値は、配送の期待値(thread, 記録された codex_home)。
  const ROUTES = {
    'new actas': (c, system) => {
      const { profile, env } = profileFor(c, system);
      record(c, { ...env, CODEX_THREAD_ID: thread });
      return { profile };
    },
    'existing seat': (c, system) => {
      const { profile, env } = profileFor(c, system);
      record(c, { ...env, CODEX_THREAD_ID: olderThread });
      const before = readFileSync(roleFile(c));
      record(c, env); // CODEX_THREAD_ID なし: 推測で seat を作り替えない
      assert.deepEqual(readFileSync(roleFile(c)), before, 'a record without a thread id leaves the existing seat byte for byte');
      record(c, { ...env, CODEX_THREAD_ID: thread });
      return { profile };
    },
    resume: (c, system) => {
      const { profile, env } = profileFor(c, system);
      record(c, { ...env, CODEX_THREAD_ID: thread });
      // 新しい TUI が同じ thread で再開した。SessionStart hook が profile を publish する。
      sh(c, 'session-start.sh', ['codex', c.proj], { ...env, CODEX_THREAD_ID: thread, AGMSG_SELF_NAME: 'off' },
        { input: JSON.stringify({ session_id: thread }) });
      assert.equal(readFileSync(path.join(c.run, `codex-thread-home.${thread}`), 'utf8').trim(), profile,
        'the hook publishes the profile for the thread');
      // app-server の tool shell は CODEX_HOME を持たない。
      record(c, { CODEX_THREAD_ID: thread });
      return { profile };
    },
  };

  for (const system of ['A', 'B']) {
    for (const [route, makeRecord] of Object.entries(ROUTES)) {
      test(`profile ${system} / ${route}: the recorded destination is delivered to`, async (t) => {
        const c = caseRoot(`${system}-${route.replace(/\s+/g, '-')}`);
        const { profile } = makeRecord(c, system);
        assert.equal(roleField(c, 'type'), 'codex');
        assert.equal(roleField(c, 'session'), thread);
        assert.equal(roleField(c, 'codex_home'), profile, 'the record holds the absolute, canonical profile path');
        assert.ok(path.isAbsolute(roleField(c, 'codex_home')));
        assert.ok(strictlyUnder(R, roleField(c, 'codex_home')), 'the profile is inside the isolation root, never the real home');
        rollout(profile, thread, c);
        sendMessage(c);
        const { db, channel } = openChannel(t, c);
        await channel.pollOnce();
        assertDelivered(t, c, db, channel, profile, thread);
        await assertNoDuplicate(c, db, channel);
      });
    }
  }

  test('negative control N1: with no HOME and no CODEX_HOME nothing is recorded as a destination and nothing is delivered', async (t) => {
    const c = caseRoot('N1');
    const { profile } = profileFor(c, 'A');
    rollout(profile, thread, c);
    // 「HOME なし」: 空の HOME(実 HOME へ fallback させない)。CODEX_HOME も無い。
    record(c, { CODEX_THREAD_ID: thread }, { home: '' });
    assert.equal(roleField(c, 'codex_home'), undefined, 'no profile is recorded');
    sendMessage(c);
    const { channel } = openChannel(t, c);
    await channel.pollOnce();
    assert.equal(calls(c).length, 0);
    const seat = seatRow(channel);
    assert.equal(seat?.state, 'unaddressable');
    assert.equal(seat?.reason, 'role_session_missing');
  });

  test('negative control N2: a relative codex_home in the record is refused', async (t) => {
    const c = caseRoot('N2');
    const { profile } = profileFor(c, 'A');
    rollout(profile, thread, c);
    record(c, { CODEX_THREAD_ID: thread });
    const original = readFileSync(roleFile(c), 'utf8');
    assert.match(original, /^codex_home=/m);
    writeFileSync(roleFile(c), original.replace(/^codex_home=.*$/m, 'codex_home=relative/home'));
    sendMessage(c);
    const { channel } = openChannel(t, c);
    await channel.pollOnce();
    assert.equal(calls(c).length, 0);
    const seat = seatRow(channel);
    assert.equal(seat?.state, 'unaddressable');
    assert.equal(seat?.reason, 'codex_home_invalid');
  });

  test('case H: a surviving child keeps the delivery pending without a duplicate, and releasing it confirms', async (t) => {
    const c = caseRoot('H');
    const { profile } = profileFor(c, 'A');
    record(c, { CODEX_THREAD_ID: thread });
    rollout(profile, thread, c);
    sendMessage(c);
    try { execFileSync('mkfifo', [underRoot(c.fifo)]); } catch (error) { assert.fail(`mkfifo failed: ${error.message}`); }
    const { db, channel } = openChannel(t, c, { env: { AGMSG_TEST_HOLD_FIFO: c.fifo } });

    // 後始末。signal は送らない: FIFO を解放し、同じ保持役が残っていれば失敗にする。
    let holder; // { pid, witness }
    const holderAlive = () => {
      if (!holder) return false;
      try { process.kill(holder.pid, 0); } catch { return false; }
      return processStartWitness(holder.pid) === holder.witness;
    };
    const release = () => {
      try {
        const fd = openSync(c.fifo, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
        try { writeSync(fd, 'x'); } finally { closeSync(fd); }
        return true;
      } catch (error) {
        if (error.code === 'ENXIO' || error.code === 'ENOENT') return false;
        throw error;
      }
    };
    t.after(() => {
      release();
      if (holderAlive()) {
        throw new Error(`holder process ${holder.pid} (start ${holder.witness}) is still alive; it ends by itself within 30 seconds of its start. No signal is sent.`);
      }
    });

    // 手順 1
    const startedAt = Date.now();
    await channel.pollOnce();
    assert.equal(calls(c).length, 1);
    const first = queueRows(db);
    assert.equal(first.length, 1);
    assert.equal(first[0].state, 'pending', 'a live group keeps the row pending');
    assert.equal(first[0].queue_item_id, calls(c)[0].itemId);
    assert.equal(JSON.parse(first[0].children).result, 'queued');
    const pgid = JSON.parse(first[0].children).pgid;
    const holderPid = Number(readFileSync(c.holderPid, 'utf8'));
    assert.notEqual(holderPid, pgid, 'the holder is a descendant, not the leader');
    const witness = processStartWitness(holderPid);
    assert.ok(witness, 'the start witness of the holder must be readable on this platform (fail closed)');
    holder = { pid: holderPid, witness };
    t.diagnostic(`first poll: pending; pgid=${pgid} holder=${holderPid} witness=${witness}`);
    // 手順 2
    await channel.pollOnce();
    assert.equal(calls(c).length, 1);
    assert.equal(queueRows(db).length, 1);
    assert.equal(queueRows(db)[0].state, 'pending');
    // 手順 3: 解放(ENXIO の間は再試行。上限 10 秒)
    const releasedAt = Date.now();
    await waitFor(release, 10000, () => 'the holder never opened the FIFO for reading');
    // 手順 4: グループの消滅を待つ(上限 10 秒。signal は送らない)
    await waitFor(() => {
      try { process.kill(-pgid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
    }, 10000, () => `process group ${pgid} still exists; holder ${holderPid} recorded witness ${witness}, now ${processStartWitness(holderPid)}`);
    const goneAt = Date.now();
    // 手順 5
    await channel.pollOnce();
    const last = queueRows(db);
    assert.equal(last.length, 1);
    assert.equal(last[0].state, 'confirmed');
    assert.equal(calls(c).length, 1, 'the notified cursor stops a re-nudge');
    t.diagnostic(`pending -> confirmed; first poll ${releasedAt - startedAt} ms, release to group gone ${goneAt - releasedAt} ms`);
  });
}
