import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';

const supervisor = new URL('../scripts/drivers/types/antigravity/antigravity-tui-supervisor.py', import.meta.url).pathname;
const repo = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

function runPython(source) {
  const result = spawnSync('python3', ['-c', source], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONPYCACHEPREFIX: '/tmp/agmsg-pycache' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('TUI envelope は複数メッセージをID順に一対一で表現する', () => {
  runPython(`
import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location('supervisor', ${JSON.stringify(supervisor)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
s = module.Supervisor.__new__(module.Supervisor)
batch = {'id': 'batch-1', 'messages': [
  {'id': 'm-1', 'from': 'agy', 'at': '2026-09-06T06:00:00Z', 'body': '一件目'},
  {'id': 'm-2', 'from': 'claude', 'at': '2026-09-06T06:01:00Z', 'body': '二件目\\x1b'},
]}
text = s.envelope(batch)
assert '[agmsg batch id=batch-1 ' in text
assert 'count=2' in text
assert text.index('id=m-1') < text.index('id=m-2')
assert text.count('[/agmsg message]') == 2
assert '\\\\x1b' in text
assert 'AGMSG_RECEIVED:batch-1' not in text
assert 'ASCIIコロン（U+003A）、batch idを空白なしで連結' in text
`);
});

test('TUI注入はbracketed pasteとCRを付け、送信状態を保存する', () => {
  runPython(`
import importlib.util
import os
spec = importlib.util.spec_from_file_location('supervisor', ${JSON.stringify(supervisor)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
r, w = os.pipe()
s = module.Supervisor.__new__(module.Supervisor)
s.master = w
s.state = {'batch': {'id': 'batch-2', 'messages': [
  {'id': 'm-1', 'from': 'agy', 'at': '2026-09-06T06:00:00Z', 'body': '本文'},
]}, 'supervisorPhase': 'PREPARED'}
s.save = lambda: None
s.inject()
data = os.read(r, 65536)
assert data.startswith(b'\\x1b[200~')
assert data.endswith(b'\\x1b[201~\\r')
assert s.state['batch']['phase'] == 'sent'
assert s.state['supervisorPhase'] == 'WAITING_FOR_RESULT'
assert s.state['batch']['receipt'] == 'AGMSG_RECEIVED:batch-2'
os.close(r); os.close(w)
`);
});

test('人間入力によるpauseは一度だけ再開方法を通知する', () => {
  runPython(`
import contextlib
import importlib.util
import io
spec = importlib.util.spec_from_file_location('supervisor', ${JSON.stringify(supervisor)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
s = module.Supervisor.__new__(module.Supervisor)
s.state = {'manualResumeRequired': False, 'supervisorPhase': 'WAITING_FOR_IDLE'}
s.save = lambda: None
notice = io.StringIO()
with contextlib.redirect_stderr(notice):
    s.pause_for_human_input()
    s.pause_for_human_input()
assert s.state['manualResumeRequired'] is True
assert s.human_input_seen is True
assert s.idle_ready is False
assert notice.getvalue().count('$agmsg resume') == 1
`);
});

test('receiptはread chunk境界をまたいでも画面上の完全行として判定できる', () => {
  runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location('supervisor', ${JSON.stringify(supervisor)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
expected = 'AGMSG_RECEIVED:batch-3'
screen = module.TerminalScreen(4, 80)
screen.feed(b'AGMSG_REC')
assert not screen.has_line(expected)
screen.feed(b'EIVED:batch-3\\r\\n? for shortcuts')
assert screen.has_line(expected)
assert screen.lines_after(expected).splitlines()[0] == '? for shortcuts'
`);
});

test('実agy型の差分描画からreceipt行を復元し未知制御は不確実とする', () => {
  runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location('supervisor', ${JSON.stringify(supervisor)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
screen = module.TerminalScreen(40, 120)
target = 'AGMSG_RECEIVED:batch-4'
screen.feed(b'\\x1b[10;3HAGMSG_RECEIV')
screen.feed(b'\\x1b[10;15HED:batch-4\\r\\n')
assert screen.has_line(target)
assert screen.lines_after(target) is not None
assert not screen.uncertain
screen.feed(b'\\x1b[1z')
assert screen.uncertain
screen = module.TerminalScreen(40, 120)
screen.feed(b'\\x1b[?1049h')
assert screen.uncertain
`);
});

test('全角セルの片側上書きや編集で偽receiptを合成しない', () => {
  runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location('supervisor', ${JSON.stringify(supervisor)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
target = 'AGMSG_RECEIVED:batch-wide'
for column in (15, 16):
    screen = module.TerminalScreen(3, 80)
    screen.feed('AGMSG_RECEIVED、batch-wide'.encode())
    screen.feed(f'\\x1b[1;{column}H:'.encode())
    assert not screen.has_line(target), screen.lines()
    assert not any(cell == '' and (index == 0 or not screen._wide_lead(screen.cells[0][index - 1])) for index, cell in enumerate(screen.cells[0]))
`);
});

test('受信turn中のresizeは画面判定を不確実にする', () => {
  runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location('supervisor', ${JSON.stringify(supervisor)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
target = 'AGMSG_RECEIVED:batch-resize'
screen = module.TerminalScreen(2, 80)
screen.feed((target + ' suffix').encode())
assert not screen.has_line(target)
assert screen.resize(2, len(target))
assert screen.has_line(target)
assert screen.uncertain
`);
});

test('親terminalのwinsizeをagy PTYへ同期する', () => {
  runPython(`
import fcntl
import importlib.util
import os
import struct
import termios
spec = importlib.util.spec_from_file_location('supervisor', ${JSON.stringify(supervisor)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
outer_master, outer_slave = os.openpty()
inner_master, inner_slave = os.openpty()
expected = struct.pack('HHHH', 41, 121, 0, 0)
fcntl.ioctl(outer_slave, termios.TIOCSWINSZ, expected)
s = module.Supervisor.__new__(module.Supervisor)
s.master = inner_master
s.child = None
s.state = {'supervisorPhase': 'WAITING_FOR_RESULT'}
s.screen = module.TerminalScreen(40, 120)
s.idle_ready = True
s.read_winsize = lambda _fd: fcntl.ioctl(outer_slave, termios.TIOCGWINSZ, struct.pack('HHHH', 0, 0, 0, 0))
s.sync_winsize()
actual = fcntl.ioctl(inner_slave, termios.TIOCGWINSZ, struct.pack('HHHH', 0, 0, 0, 0))
assert actual == expected
assert (s.screen.rows, s.screen.cols) == (41, 121)
assert s.screen.uncertain
s.state = {'supervisorPhase': 'WAITING_FOR_IDLE'}
s.idle_ready = True
fcntl.ioctl(outer_slave, termios.TIOCSWINSZ, struct.pack('HHHH', 42, 122, 0, 0))
s.sync_winsize()
assert (s.screen.rows, s.screen.cols) == (42, 122)
assert not s.screen.uncertain
assert not s.idle_ready
for fd in (outer_master, outer_slave, inner_master, inner_slave): os.close(fd)
`);
});

test('TUI monitor は対話端末でない起動を拒否する', () => {
  const wrapper = new URL('../scripts/drivers/types/antigravity/antigravity-tui-monitor.sh', import.meta.url).pathname;
  const result = spawnSync('bash', [wrapper, '--help'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /対話端末/);
  const status = spawnSync('bash', [wrapper, 'status', '--project', '/tmp', '--team', 'no-such-team', '--name', 'no-such-role'], { encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /tui-pty 未起動/);
});

test('偽TUIを実PTYで起動し、受信後のreceipt確認からackまで進める', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agmsg-tui-pty-test-'));
  const install = path.join(dir, 'install');
  const project = path.join(dir, 'project');
  fs.mkdirSync(install);
  fs.mkdirSync(project);
  fs.cpSync(path.join(repo, 'scripts'), path.join(install, 'scripts'), { recursive: true });
  const fake = path.join(dir, 'agy');
  fs.writeFileSync(path.join(dir, 'fake.mjs'), `
process.stdout.write('? for shortcuts\\n');
let input = '';
process.stdin.on('data', chunk => {
  input += chunk.toString();
  const match = input.match(/\\[agmsg batch id=([^ ]+) count=/);
  if (!match) {
    if (input.includes('D')) { process.stdout.write('? for shortcuts\\n'); input = ''; }
    return;
  }
  if (!input.includes('[/agmsg batch]')) return;
  if (input.includes('NO_RECEIPT')) { process.stdout.write(input + '\\n? for shortcuts\\n'); input = ''; return; }
  const receipt = 'AGMSG_RECEIVED:' + match[1];
  if (input.includes('RENDER_THEN_RECEIPT')) process.stdout.write(input + '\\n' + receipt + '\\n? for shortcuts\\n');
  else process.stdout.write(receipt + '\\n? for shortcuts\\n');
  input = '';
});
`);
  fs.writeFileSync(fake, `#!/bin/sh\nexec '${process.execPath}' '${path.join(dir, 'fake.mjs')}'\n`, { mode: 0o700 });
  const env = {
    ...process.env,
    AGMSG_STORAGE_DRIVER: 'sqlite',
    AGMSG_STORAGE_PATH: path.join(install, 'db'),
    AGMSG_CONFIG: path.join(dir, 'config.json'),
  };
  const run = (script, args) => {
    const result = spawnSync('bash', [path.join(install, 'scripts', script), ...args], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result.stdout;
  };
  run('join.sh', ['fixture', 'worker', 'antigravity', project]);
  run('join.sh', ['fixture', 'sender', 'codex', project]);
  run('delivery.sh', ['set', 'monitor', 'antigravity', project]);

  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const command = 'stty rows 40 cols 120; exec ' + [
    'bash', quote(path.join(install, 'scripts/drivers/types/antigravity/antigravity-tui-monitor.sh')),
    '--project', quote(project), '--team', 'fixture', '--name', 'worker', '--agy', quote(fake), '--poll', '0.05',
  ].join(' ');
  const child = spawn('script', ['-qefc', command, '/dev/null'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  const waitFor = async predicate => {
    for (let i = 0; i < 200; i += 1) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`待機timeout: ${output}`);
  };
  try {
    await waitFor(() => output.includes('? for shortcuts'));
    run('send.sh', ['fixture', 'sender', 'worker', 'PTY E2E']);
    await waitFor(() => output.includes('AGMSG_RECEIVED:') && fs.readdirSync(path.join(install, 'run')).some(name => name.endsWith('.state.json')));
    const stateFile = fs.readdirSync(path.join(install, 'run')).find(name => name.endsWith('.state.json'));
    await waitFor(() => JSON.parse(fs.readFileSync(path.join(install, 'run', stateFile), 'utf8')).batch === null);
    assert.match(output, /AGMSG_RECEIVED:/);
    assert.match(run('inbox.sh', ['fixture', 'worker']), /No new messages\./);
    child.stdin.write('D');
    await waitFor(() => JSON.parse(fs.readFileSync(path.join(install, 'run', stateFile), 'utf8')).manualResumeRequired === true);
    const resume = spawnSync('python3', [path.join(install, 'scripts/drivers/types/antigravity/antigravity-tui-supervisor.py'), '--action', 'resume', '--project', project, '--team', 'fixture', '--name', 'worker'], { env, encoding: 'utf8' });
    assert.equal(resume.status, 0, resume.stderr);
    await waitFor(() => JSON.parse(fs.readFileSync(path.join(install, 'run', stateFile), 'utf8')).manualResumeRequired === false);
    run('send.sh', ['fixture', 'sender', 'worker', 'RENDER_THEN_RECEIPT']);
    await waitFor(() => JSON.parse(fs.readFileSync(path.join(install, 'run', stateFile), 'utf8')).batch?.messages?.some(message => message.body === 'RENDER_THEN_RECEIPT'));
    await waitFor(() => JSON.parse(fs.readFileSync(path.join(install, 'run', stateFile), 'utf8')).batch === null);
    assert.match(run('inbox.sh', ['fixture', 'worker']), /No new messages\./);
    run('send.sh', ['fixture', 'sender', 'worker', 'NO_RECEIPT']);
    await waitFor(() => JSON.parse(fs.readFileSync(path.join(install, 'run', stateFile), 'utf8')).batch?.phase === 'sent');
    await new Promise(resolve => setTimeout(resolve, 300));
    const uncertain = JSON.parse(fs.readFileSync(path.join(install, 'run', stateFile), 'utf8'));
    assert.notEqual(uncertain.batch, null);
    const supervisorPath = path.join(install, 'scripts/drivers/types/antigravity/antigravity-tui-supervisor.py');
    const status = spawnSync('python3', [supervisorPath, '--action', 'status', '--project', project, '--team', 'fixture', '--name', 'worker'], { env, encoding: 'utf8' });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /runtime: worker tui-pty busy/);
    const stop = spawnSync('python3', [supervisorPath, '--action', 'stop', '--project', project, '--team', 'fixture', '--name', 'worker'], { env, encoding: 'utf8' });
    assert.equal(stop.status, 0, stop.stderr);
    await waitFor(() => child.exitCode !== null);
    assert.match(stop.stdout, /停止要求を送信しました/);
    assert.match(fs.readFileSync(path.join(install, 'run', stateFile), 'utf8'), /"phase": "uncertain"|"phase":"uncertain"/);
    const rejected = spawnSync('python3', [supervisorPath, '--action', 'ack', '--project', project, '--team', 'fixture', '--name', 'worker', '--batch', uncertain.batch.id, '--confirm-id', 'wrong-id'], { env, encoding: 'utf8' });
    assert.notEqual(rejected.status, 0);
    const recover = spawnSync('python3', [supervisorPath, '--action', 'ack', '--project', project, '--team', 'fixture', '--name', 'worker', '--batch', uncertain.batch.id, '--confirm-id', uncertain.batch.messages[0].id], { env, encoding: 'utf8' });
    assert.equal(recover.status, 0, recover.stderr);
    assert.match(recover.stdout, /復旧ackを完了しました/);
    assert.match(run('inbox.sh', ['fixture', 'worker']), /No new messages\./);
  } finally {
    if (child.exitCode === null) child.stdin.write('\x04');
    await Promise.race([once(child, 'close'), new Promise(resolve => setTimeout(resolve, 5000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});
