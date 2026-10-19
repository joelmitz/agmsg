// Child-process environment for node tests that run agmsg's shell helpers.
//
// The node counterpart of tests/test_helper.bash's top-level unsets and
// setup_test_env(). A test that spreads `...process.env` into a child that runs
// join.sh / send.sh / inbox.sh / history.sh hands that child the developer's
// terminal: the self-naming hook (scripts/lib/self-name.sh) reads TMUX* /
// HERDR_* to find "this pane" and names it with the fixture's team:agent.
// Measured 2026-10-19: `node --test tests/antigravity_diagnose.test.mjs` run
// inside a herdr pane relabelled that real pane `demo:agy`.
//
// So every child gets, by default:
//   - no terminal markers (TMUX*, HERDR_*, ORCA_*), and AGMSG_SELF_NAME=off;
//   - none of the host CLI session / profile / delivery variables the bats
//     helper also clears (they change which branch a script takes);
//   - a PATH without a host `orca` that is not the Orca IDE CLI (on a Linux
//     desktop /usr/bin/orca is GNOME's screen reader, which where.sh's terminal
//     sweep would launch and which does not exit). Same mirror as the bats
//     helper: each PATH dir holding an `orca` is replaced by a directory of
//     symlinks to everything else in it.
//
// `extra` is applied last. A key whose value is `undefined` is removed, so a
// test that deliberately opts back into self-naming against a FAKE terminal
// writes `{ AGMSG_SELF_NAME: undefined, TMUX: ..., PATH: fakeBin + ':' + ... }`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TERMINAL_PREFIXES = ['TMUX', 'HERDR_', 'ORCA_'];
const CLEARED = [
  // claude-code transcript root (#1229)
  'CLAUDE_CONFIG_DIR',
  // caller identity / strong detect markers
  'AGMSG_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SANDBOX',
  'GROK_SESSION_ID', 'GEMINI_CLI', 'GEMINI_API_KEY',
  // Codex state roots
  'CODEX_HOME', 'AGMSG_CODEX_HOME',
  // a Claude Code shell's own delivery settings
  'AGMSG_CC_MONITOR_KEEP_ALIVE', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
];

let cachedPath = null;

function mirrorWithoutOrca(dir, root) {
  const shadow = path.join(root, dir.replace(/\//g, '_'));
  if (fs.existsSync(shadow)) return shadow;
  const tmp = fs.mkdtempSync(path.join(root, '.tmp.'));
  // A symlink failure throws, and a short mirror is refused below: never put an
  // incomplete copy of a PATH dir in its place.
  const names = fs.readdirSync(dir).filter((name) => name !== 'orca');
  for (const name of names) fs.symlinkSync(path.join(dir, name), path.join(tmp, name));
  if (fs.readdirSync(tmp).length !== names.length) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error(`isolated-env: incomplete orca-free mirror of ${dir}`);
  }
  try { fs.renameSync(tmp, shadow); } catch { fs.rmSync(tmp, { recursive: true, force: true }); }
  if (!fs.existsSync(shadow) || fs.existsSync(path.join(shadow, 'orca'))) {
    throw new Error(`isolated-env: could not build an orca-free mirror of ${dir}`);
  }
  return shadow;
}

// PATH with every directory that holds an executable `orca` replaced by its
// orca-free mirror. Built once per process; a host without `orca` (CI) gets its
// PATH back unchanged.
export function isolatedPath(basePath = process.env.PATH || '') {
  if (cachedPath !== null && basePath === process.env.PATH) return cachedPath;
  let root = null;
  const out = basePath.split(':').map((dir) => {
    if (!dir) return dir;
    const orca = path.join(dir, 'orca');
    try { fs.accessSync(orca, fs.constants.X_OK); } catch { return dir; }
    if (!fs.statSync(orca).isFile()) return dir;
    if (root === null) {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'agmsg-path-no-orca-'));
      const made = root;
      process.on('exit', () => { try { fs.rmSync(made, { recursive: true, force: true }); } catch {} });
    }
    return mirrorWithoutOrca(dir, root);
  }).join(':');
  if (basePath === process.env.PATH) cachedPath = out;
  return out;
}

export function isolatedEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (TERMINAL_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    if (CLEARED.includes(key)) continue;
    env[key] = value;
  }
  env.PATH = isolatedPath();
  env.AGMSG_SELF_NAME = 'off';
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}
