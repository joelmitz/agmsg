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
assert 'AGMSG_RECEIVED:batch-1:' in text
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
assert s.state['batch']['receipt'].startswith('AGMSG_RECEIVED:batch-2:')
os.close(r); os.close(w)
`);
});

test('TUI monitor は対話端末でない起動を拒否する', () => {
  const wrapper = new URL('../scripts/drivers/types/antigravity/antigravity-tui-monitor.sh', import.meta.url).pathname;
  const result = spawnSync('bash', [wrapper, '--help'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /対話端末/);
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
  const match = input.match(/\\[agmsg batch id=([^ ]+) receipt=([^ ]+)/);
  if (!match) return;
  process.stdout.write('AGMSG_RECEIVED:' + match[1] + ':' + match[2] + '\\n? for shortcuts\\n');
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
  const command = [
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
    const supervisorPath = path.join(install, 'scripts/drivers/types/antigravity/antigravity-tui-supervisor.py');
    const status = spawnSync('python3', [supervisorPath, '--action', 'status', '--project', project, '--team', 'fixture', '--name', 'worker'], { env, encoding: 'utf8' });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /runtime: worker tui-pty running/);
    const stop = spawnSync('python3', [supervisorPath, '--action', 'stop', '--project', project, '--team', 'fixture', '--name', 'worker'], { env, encoding: 'utf8' });
    assert.equal(stop.status, 0, stop.stderr);
    await waitFor(() => child.exitCode !== null);
    assert.match(stop.stdout, /停止要求を送信しました/);
  } finally {
    if (child.exitCode === null) child.stdin.write('\x04');
    await Promise.race([once(child, 'close'), new Promise(resolve => setTimeout(resolve, 5000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});
