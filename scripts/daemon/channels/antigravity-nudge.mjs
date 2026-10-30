// Delivers a one-line notice to Antigravity (agy) seats whose project chose
// agmsgd, by typing it into the seat's pane through agy-nudge.sh (poke's pane
// path: placement record, terminal driver, safe-poke with the confirmation-
// screen and draft guards). It carries no message text; the agent reads its own
// inbox and that read is what marks messages read. This channel never writes a
// message, a read cursor, a role-session record or a rule file.
//
// Off, then dry, then live, with two separate switches under run/:
//   agmsgd-antigravity-delivery   without it this channel does nothing at all
//   agmsgd-antigravity-live       without it (or without the delivery file) the
//                                 channel only DRY-RUNS: it runs every check
//                                 against the real screen, types nothing, and
//                                 records what it would have sent
// A seat is considered only when ALL of these hold, re-read on every poll:
//   1. its project explicitly chose agmsgd (run/delivery-choice)
//   2. no supervisor reservation exists for it (a monitor owns the seat)
//   3. its rule file is not the monitor marker
//   4. the delivery file exists
// Anything else records a reason and nothing is run. Only a pane on this host
// is reachable: the terminal driver talks to the local terminal manager, and a
// daemon environment that points the manager at another machine is refused.

import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { assertPollActive } from "../poll-deadline.mjs";
import { logLine, deliveryEvent } from "../log.mjs";
import { withImmediateTransaction } from "../db.mjs";
import { readDeliveryChoice } from "./delivery-choice.mjs";
import { messageStorePath, openMessageStore, readStorageDriver, readUnreadSnapshot } from "./codex-queue-store.mjs";
import { inboxNudge, newNonce } from "./codex-queue-io.mjs";
import { seatKey } from "./codex-queue.mjs";
import { encodeName, listAntigravityRegistrations, readDeliveryMode } from "./antigravity-observe.mjs";
import { homedir } from "node:os";

export const DELIVERY_FLAG = "agmsgd-antigravity-delivery";
export const LIVE_FLAG = "agmsgd-antigravity-live";
export const CHANNEL_NAME = "antigravity-nudge";
const TYPE = "antigravity";
const NUDGE_TIMEOUT_MS = 10_000;
// A nudge on Windows takes about 10 s (measured on a real machine: Git Bash start-up
// and several local terminal-manager calls), so it gets a longer bound there; it
// stays under the 30 s channel deadline.
const NUDGE_TIMEOUT_WINDOWS_MS = 25_000;
// The one-word reasons agy-nudge.sh may give when it typed the line but cannot confirm it was submitted.
export const SUBMIT_REASONS = new Set(["box_has_line", "box_empty", "box_mismatch", "confirmation_screen", "box_unlocated", "peek_failed", "enter_send_failed"]);
export const nudgeTimeoutFor = (platform) => (platform === "win32" ? NUDGE_TIMEOUT_WINDOWS_MS : NUDGE_TIMEOUT_MS);
const KILL_GRACE_MS = 1_000;
const BACKOFF_FIRST_MS = 5_000;
const BACKOFF_MAX_MS = 300_000;
const SCREEN_RECHECK_MS = 60_000;
const UNCONFIRMED_LIMIT = 10;

export const ANTIGRAVITY_NUDGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS beta_antigravity_nudge (
  seat TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('idle', 'delivering', 'dry_run', 'deferred', 'blocked', 'unaddressable', 'ineligible')),
  reason TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'dry' CHECK (mode IN ('dry', 'live')),
  up_to TEXT NOT NULL DEFAULT '',
  dry_up_to TEXT NOT NULL DEFAULT '',
  last_nudge_at TEXT,
  last_dry_at TEXT,
  would_send TEXT,
  unread INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_try_at TEXT,
  checked_at TEXT NOT NULL,
  inflight_up_to TEXT NOT NULL DEFAULT ''
);
`;

function regularFile(path) {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch { return false; }
}
export const deliveryEnabled = (installRoot) => regularFile(join(installRoot, "run", DELIVERY_FLAG));
// Live needs BOTH files: the live file alone never sends.
export const liveEnabled = (installRoot) => deliveryEnabled(installRoot) && regularFile(join(installRoot, "run", LIVE_FLAG));

// A daemon environment that aims the terminal manager at another machine.
// The agmsg terminal drivers address local panes only, so this is refused
// rather than guessed around.
export function remoteTargetConfigured(env) {
  return Object.keys(env).some((key) => /^(AGMSG_)?HERDR_(MACHINE|REMOTE)/i.test(key) && env[key]);
}

// Windows spells one folder several ways: C:\a\b, C:/a/b, /c/a/b (Git Bash).
// delivery-choice is written by Git Bash (`pwd -P`, /c/...) while a registration
// may hold another spelling. Only the SPELLING is normalized, and only for an
// absolute drive path: a drive-relative "C:" or "C:x", a UNC name or a relative
// path is refused (null). Case is kept except for the drive letter, because a
// Windows directory can be case-sensitive; an unverifiable match is a non-match.
export function toNativeWindowsPath(path) {
  if (typeof path !== "string") return null;
  let value = path.replace(/\\/g, "/");
  const gitBash = value.match(/^\/([A-Za-z])(\/.*)?$/);
  if (gitBash) value = `${gitBash[1]}:${gitBash[2] ?? "/"}`;
  const drive = value.match(/^([A-Za-z]):\/(.*)$/);
  if (!drive) return null;
  const rest = drive[2].replace(/\/+/g, "/").replace(/\/$/, "");
  return `${drive[1].toUpperCase()}:/${rest}`;
}
export const normalizeWindowsProject = toNativeWindowsPath;

function readChoiceLines(installRoot) {
  try { return readFileSync(join(installRoot, "run", "delivery-choice"), "utf8").split(/\r?\n/).map((line) => line.split("\t")); } catch { return []; }
}

export function chosenAgmsgd(installRoot, projects, platform = process.platform) {
  if (!projects.length) return false;
  if (platform === "win32") {
    const lines = readChoiceLines(installRoot).filter(([type, , value]) => type === TYPE && /^[a-z]+$/.test(value ?? ""));
    return projects.every((project) => {
      if (typeof project !== "string" || !project) return false;
      const wanted = toNativeWindowsPath(project);
      if (!wanted) return false;
      // A line that names the folder with different letter case might be the same
      // folder (the usual Windows case) or another one (a case-sensitive folder),
      // and which is not checked here. Either way it could be a later opt-out, so
      // such a conflict is refused rather than skipped.
      const folded = wanted.toLowerCase();
      const alias = lines.some(([, path]) => { const native = toNativeWindowsPath(path); return native && native !== wanted && native.toLowerCase() === folded; });
      if (alias) return false;
      // As readDeliveryChoice: the last matching line is the choice.
      const matching = lines.filter(([, path]) => toNativeWindowsPath(path) === wanted);
      return matching.length > 0 && matching[matching.length - 1][2] === "agmsgd";
    });
  }
  return projects.every((project) => {
    if (typeof project !== "string" || !project) return false;
    const names = new Set([project]);
    try { names.add(realpathSync(project)); } catch { /* an unreachable project keeps its literal name */ }
    return [...names].some((name) => readDeliveryChoice(installRoot, TYPE, name) === "agmsgd");
  });
}

// The rule file's mode where an unreadable file must NOT read as "not monitor":
// the project folder must exist and the file must be readable or plainly absent
// (ENOENT). Anything else is "unreadable", which the gate refuses.
const MONITOR_MARKER = "<!-- agmsg:antigravity:monitor -->";
export function readDeliveryModeStrict(projects, { readFile = readFileSync, isDirectory = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } } } = {}) {
  let mode = "none";
  for (const project of projects) {
    if (!isDirectory(project)) return "unreadable";
    try {
      const text = readFile(join(project, ".agent", "rules", "agmsg.md"), "utf8");
      if (String(text).split(/\r?\n/).includes(MONITOR_MARKER)) return "monitor";
      mode = "turn";
    } catch (error) { if (error?.code !== "ENOENT") return "unreadable"; }
  }
  return mode;
}

// Any trace of a supervisor reservation for this seat, in either file format
// (the legacy name may omit "type"). Existence is enough, and so is a record that
// cannot be inspected: this gate never judges whether the record is stale.
export function reservationTrace(runDir, team, agent) {
  const key = `${encodeName(team)}__${encodeName(agent)}`;
  for (const name of [`read-reservation.${key}.json`, `antigravity-reservation.${key}.json`]) {
    try { lstatSync(join(runDir, name)); return true; } catch (error) { if (error?.code !== "ENOENT") return true; }
  }
  return false;
}

// Reads only. Returns "" when the seat may be nudged, else a fixed reason.
export function ineligibleReason({ installRoot, registration, env, platform = process.platform, readMode = platform === "win32" ? readDeliveryModeStrict : readDeliveryMode }) {
  if (remoteTargetConfigured(env)) return "remote_pane_unsupported";
  if (!chosenAgmsgd(installRoot, registration.projects, platform)) return "delivery_not_chosen";
  if (reservationTrace(join(installRoot, "run"), registration.team, registration.agent)) return "supervisor_present";
  // Node reads the rule file itself, and Git Bash's path conversion does not apply to
  // Node: on Windows every registration is turned into a native absolute path first,
  // and one that cannot be is not guessed at.
  let projects = registration.projects;
  if (platform === "win32") {
    projects = registration.projects.map(toNativeWindowsPath);
    if (projects.some((project) => !project)) return "project_path_unresolved";
  }
  const mode = readMode(projects);
  if (mode === "unreadable") return "rule_unreadable";
  if (mode === "monitor") return "monitor_mode";
  return "";
}

// What agy-nudge.sh's exit status means for this seat.
export function classifyExit(code) {
  switch (code) {
    case 0: return { sent: true };
    case 14: return { state: "deferred", reason: "draft", backoff: true };
    case 15: return { state: "deferred", reason: "input_box_unconfirmed", backoff: true, counts: true };
    case 16: return { state: "blocked", reason: "confirmation_screen", recheckMs: SCREEN_RECHECK_MS };
    case 10: case 12: return { state: "unaddressable", reason: "pane_unreachable", backoff: true };
    case 13: return { state: "unaddressable", reason: "no_pane", backoff: true };
    case 20: return { state: "unaddressable", reason: "no_placement", backoff: true };
    case 21: return { state: "unaddressable", reason: "placement_unresolved", backoff: true };
    case 22: return { state: "blocked", reason: "seat_type_mismatch", backoff: true };
    // Typed, but the Enter that submits it is not confirmed: the line may be sitting in the
    // input box. Counted as notified (never typed a second time) and shown, not retried.
    case 23: return { state: "blocked", reason: "enter_unconfirmed", typed: true };
    default: return { state: "blocked", reason: "nudge_failed", backoff: true };
  }
}

// The bash that runs agy-nudge.sh. On Windows a bare `bash` on PATH can be WSL's
// launcher in System32, not Git Bash, so it is named by an absolute path and
// every candidate is checked, wherever it came from (AGMSG_BASH, EXEPATH, a Git
// bin directory on PATH, Program Files): an absolute drive path ending in
// \bash.exe, not under the Windows directory, System32/SysWOW64 or WindowsApps
// (also after resolving links), a regular file, and sitting beside an MSYS
// runtime (usr\bin\msys-2.0.dll, as Git for Windows installs). null means "no
// usable bash": nothing is run.
const FORBIDDEN = /\\(system32|syswow64|windowsapps|windows)\\/i;
function acceptBash(candidate, env, { isFile, realpath }) {
  if (typeof candidate !== "string") return null;
  const path = candidate.replace(/\//g, "\\");
  if (!/^[A-Za-z]:\\/.test(path) || !/\\bash\.exe$/i.test(path) || FORBIDDEN.test(path)) return null;
  const windowsDir = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? env.WINDIR;
  const under = (value) => windowsDir && value.toLowerCase().startsWith(`${windowsDir.replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase()}\\`);
  if (under(path) || !isFile(path)) return null;
  let real = path;
  try { real = String(realpath(path)).replace(/\//g, "\\"); } catch { return null; }
  if (FORBIDDEN.test(real) || under(real) || !/\\bash\.exe$/i.test(real)) return null;
  const dir = real.slice(0, real.lastIndexOf("\\"));
  const runtime = /\\usr\\bin$/i.test(dir) ? `${dir}\\msys-2.0.dll` : /\\bin$/i.test(dir) ? `${dir.slice(0, -4)}\\usr\\bin\\msys-2.0.dll` : null;
  return runtime && isFile(runtime) ? path : null;
}

export function resolveBash({ platform = process.platform, env = process.env, isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } }, realpath = realpathSync } = {}) {
  if (platform !== "win32") return "bash";
  const candidates = [];
  if (env.AGMSG_BASH) candidates.push(env.AGMSG_BASH);
  if (env.EXEPATH) candidates.push(`${env.EXEPATH}\\bin\\bash.exe`);
  for (const dir of String(env.PATH ?? env.Path ?? "").split(";")) {
    if (/\\Git\\(usr\\)?bin\\?$/i.test(dir)) candidates.push(`${dir.replace(/\\$/, "")}\\bash.exe`);
  }
  for (const root of [env.ProgramFiles, env["ProgramFiles(x86)"]]) if (root) candidates.push(`${root}\\Git\\bin\\bash.exe`);
  for (const candidate of candidates) {
    const accepted = acceptBash(candidate, env, { isFile, realpath });
    if (accepted) return accepted;
  }
  return null;
}

// Git Bash reads C:\a\b as a path with a stray backslash in $0; hand it /c/a/b.
export function toPosixScriptPath(path, platform = process.platform) {
  if (platform !== "win32") return path;
  const value = String(path).replace(/\\/g, "/");
  return value.replace(/^([A-Za-z]):\//, (_, drive) => `/${drive.toLowerCase()}/`);
}

// Windows has no process groups here: end the whole tree of the shell.
function killTreeWindows(pid) {
  try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 3000, stdio: "ignore" }); } catch { /* already gone */ }
}

function killGroup(child, signal, platform = process.platform, killTree = killTreeWindows) {
  try {
    if (platform === "win32") { killTree(child.pid); child.kill(signal); }
    else process.kill(-child.pid, signal);
  } catch { try { child.kill(signal); } catch { /* already gone */ } }
}

// Runs agy-nudge.sh with the line on stdin. Output is read and dropped: it can
// carry paths and is never stored or logged.
// `stages`, when given, is filled in as the run goes. Parent clock (monotonic, milliseconds since the spawn): typedMs (the marker was seen), checks
// (how many delivery checks the wrapper reported starting, from NUDGE-CHECK:<n>), lastCheckMs, totalMs (when the run ended), seenMs (when each wrapper
// stage mark was seen: libs, resolved, poked) and peekSeenMs (each peek mark). Wrapper clock (wall clock, milliseconds since the wrapper's first statement,
// so the time Git Bash needed to start is not in it): wrapperMs (libs, resolved, poked) and peeksMs (each terminal peek, in order). The two clocks have
// different origins and are never subtracted from each other here. Numbers only, never text.
// Wrapper stage marks: one line `NUDGE-STAGE:<name>:<milliseconds>`; only these names and plain numbers are read.
export const STAGE_NAMES = new Set(["libs", "resolved", "peek", "poked"]);
const MAX_PEEKS = 12;
function readStageLine(stages, line, at) {
  const match = /^NUDGE-STAGE:([a-z]{1,12}):(\d{1,9})$/.exec(line);
  if (!match || !STAGE_NAMES.has(match[1])) return;
  const value = Number(match[2]);
  if (match[1] === "peek") {
    stages.peeksMs ??= []; stages.peekSeenMs ??= [];
    if (stages.peeksMs.length < MAX_PEEKS) { stages.peeksMs.push(value); stages.peekSeenMs.push(at); }
    return;
  }
  stages.wrapperMs ??= {}; stages.seenMs ??= {};
  if (!(match[1] in stages.wrapperMs)) { stages.wrapperMs[match[1]] = value; stages.seenMs[match[1]] = at; }
}

export function runNudge({ script, mode, team, agent, text, timeoutMs, signal, spawnProcess = spawn, env = process.env, platform = process.platform, bash = "bash", killTree = killTreeWindows, onTyped, stages, clock = () => performance.now() }) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve({ kind: "cancelled" }); return; }
    const limitMs = timeoutMs ?? nudgeTimeoutFor(platform);
    let child;
    try {
      child = spawnProcess(bash, [toPosixScriptPath(script, platform), mode, team, agent, "--body", "-"], { env, stdio: ["pipe", "pipe", "pipe"], detached: platform !== "win32", windowsHide: true });
    } catch { resolve({ kind: "failed" }); return; }
    const startedAt = clock();
    const since = () => Math.max(0, clock() - startedAt);
    let done = false;
    let stopping = null;
    const timers = [];
    const finish = (value) => {
      if (done) return;
      done = true;
      if (stages) stages.totalMs = since();
      timers.forEach(clearTimeout);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const hardStop = (kind) => {
      stopping ??= kind;
      killGroup(child, "SIGTERM", platform, killTree);
      timers.push(setTimeout(() => { killGroup(child, "SIGKILL", platform, killTree); child.stdout?.destroy(); child.stderr?.destroy(); child.unref?.(); finish({ kind, typed, ...(reasonWord ? { reasonWord } : {}) }); }, KILL_GRACE_MS));
    };
    const onAbort = () => hardStop("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    timers.push(setTimeout(() => hardStop("timeout"), limitMs));
    let typed = false;
    let reasonWord = "";
    let tail = "";
    let lineBuffer = "";
    // stdout is dropped except for one marker, which the wrapper prints right after typing.
    // A short tail is kept so a marker split across chunks is still found. onTyped runs once,
    // while the run is still going, so the fact "typed" is recorded before any later stop.
    child.stdout?.on("data", (chunk) => {
      tail = (tail + String(chunk)).slice(-120);
      const word = /NUDGE-REASON:([a-z_]{1,24})/.exec(tail);
      if (word && SUBMIT_REASONS.has(word[1]) && /NUDGE-REASON:[a-z_]+\n/.test(tail)) reasonWord = word[1];
      // One timestamp per chunk: events that arrive in the same chunk are not ordered against each other by the clock.
      // The wrapper prints NUDGE-TYPED before any NUDGE-CHECK, so typing is taken first.
      const at = since();
      if (stages) {
        // Whole lines only, each read once (the tail above overlaps between chunks).
        lineBuffer += String(chunk);
        let newline;
        while ((newline = lineBuffer.indexOf("\n")) >= 0) {
          readStageLine(stages, lineBuffer.slice(0, newline).replace(/\r$/, ""), at);
          lineBuffer = lineBuffer.slice(newline + 1);
        }
        if (lineBuffer.length > 200) lineBuffer = "";
      }
      if (!typed && tail.includes("NUDGE-TYPED")) { typed = true; if (stages) stages.typedMs = at; try { onTyped?.(); } catch { /* the run result still reports it */ } }
      if (stages) {
        // The wrapper prints NUDGE-CHECK:<n> when delivery check n starts; only the number is read.
        for (const match of tail.matchAll(/NUDGE-CHECK:([1-9])\n/g)) {
          const n = Number(match[1]);
          if (n > (stages.checks ?? 0)) { stages.checks = n; stages.lastCheckMs = at; }
        }
      }
    });
    child.stderr?.on("data", () => {});
    child.once("error", () => finish({ kind: "failed" }));
    child.once("close", (code) => finish(stopping ? { kind: stopping, typed, ...(reasonWord ? { reasonWord } : {}) } : code === null ? { kind: "failed", typed } : { kind: "exit", code, typed, ...(reasonWord ? { reasonWord } : {}) }));
    child.stdin?.on("error", () => {});
    child.stdin?.end(text);
  });
}

// `enter_unconfirmed` (no word): typed, outcome unknown. `enter_unconfirmed:<word>`: the wrapper finished its checks and said why it
// could not confirm. `enter_unconfirmed:timeout[:<word>]`: the run was stopped at its time limit before it finished (a word the wrapper
// had already printed is kept, not dropped).
export const unconfirmedReason = (word, kind) => {
  const known = word && SUBMIT_REASONS.has(word) ? word : "";
  if (kind === "timeout") return known ? `enter_unconfirmed:timeout:${known}` : "enter_unconfirmed:timeout";
  return known ? `enter_unconfirmed:${known}` : "enter_unconfirmed";
};
const isUnconfirmed = (reason) => reason === "interrupted_unconfirmed" || String(reason).startsWith("enter_unconfirmed");

function backoffMs(attempts) {
  return Math.min(BACKOFF_FIRST_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);
}

export function createAntigravityNudgeChannel({
  db,
  installRoot,
  env = process.env,
  now = Date.now,
  log = (message) => logLine(installRoot, message),
  listSeats = listAntigravityRegistrations,
  readDriver = readStorageDriver,
  openStore = openMessageStore,
  readSnapshot = readUnreadSnapshot,
  run = runNudge,
  hostPlatform = process.platform,
  findBash = resolveBash,
  readMode,
}) {
  let stopped = false;
  let activePoll = null;
  let schemaReady = false;
  const lastSeen = new Map();
  // In memory only (it is lost on a restart): what the last interrupted live run for a seat is known to have done.
  const outcomes = new Map();
  const lifetime = new AbortController();
  const script = join(installRoot, "scripts", "daemon", "agy-nudge.sh");

  const iso = (ms) => new Date(ms).toISOString();
  const readRow = (seat) => db.prepare("SELECT * FROM beta_antigravity_nudge WHERE seat = ?").get(seat);

  function save(seat, fields) {
    assertPollActive();
    const row = { ...(readRow(seat) ?? {}), ...fields };
    withImmediateTransaction(db, () => {
      db.prepare(`
        INSERT INTO beta_antigravity_nudge (seat, state, reason, mode, up_to, dry_up_to, last_nudge_at, last_dry_at, would_send, unread, attempts, next_try_at, checked_at, inflight_up_to)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(seat) DO UPDATE SET state=excluded.state, reason=excluded.reason, mode=excluded.mode, up_to=excluded.up_to, dry_up_to=excluded.dry_up_to,
          last_nudge_at=excluded.last_nudge_at, last_dry_at=excluded.last_dry_at, would_send=excluded.would_send, unread=excluded.unread,
          attempts=excluded.attempts, next_try_at=excluded.next_try_at, checked_at=excluded.checked_at, inflight_up_to=excluded.inflight_up_to
      `).run(seat, row.state, row.reason, row.mode ?? "dry", row.up_to ?? "", row.dry_up_to ?? "", row.last_nudge_at ?? null, row.last_dry_at ?? null,
        row.would_send ?? null, row.unread ?? 0, row.attempts ?? 0, row.next_try_at ?? null, iso(now()), row.inflight_up_to ?? "");
    });
    const signature = `${row.state}|${row.reason}|${row.mode}`;
    if (lastSeen.get(seat) !== signature) {
      lastSeen.set(seat, signature);
      deliveryEvent(log, { event: "seat_state", channel: CHANNEL_NAME, seat, reason: `${row.mode}:${row.reason}`, state: row.state });
    }
  }

  const failure = (error) => (/^E[A-Z0-9]{2,15}$/.test(error?.code ?? "") ? `nudge_failed:${error.code}` : "nudge_failed");

  async function pollSeat(registration, paths, signal) {
    // Both switches are read again for every seat, and once more right before a
    // pane is touched: removing either takes effect for the next seat.
    if (!deliveryEnabled(installRoot)) return;
    const live = liveEnabled(installRoot);
    const { team, agent, teamConfig, projects } = registration;
    const seat = seatKey(team, agent);
    const mode = live ? "live" : "dry";
    let prior = readRow(seat);
    // A live run that started in an earlier poll and never reported back (stopped, cut off by the
    // deadline, or the daemon restarted) left an in-flight record. Unless this process saw that
    // run end without a typed marker, the line may be in the pane: count it as notified, never type it
    // again, and show it.
    if (prior?.inflight_up_to) {
      const known = outcomes.get(seat);
      outcomes.delete(seat);
      // Only an interruption in THIS process with no typed marker seen is retried; the marker is printed
      // after typing, so this narrows the doubt rather than removing it.
      if (known && known.upTo === prior.inflight_up_to && !known.typed) {
        save(seat, { inflight_up_to: "" });
        prior = readRow(seat);
      } else {
        save(seat, { state: "blocked", reason: "interrupted_unconfirmed", mode, up_to: prior.inflight_up_to, last_nudge_at: prior.last_nudge_at ?? iso(now()), would_send: null, attempts: 0, next_try_at: null, inflight_up_to: "" });
        return;
      }
    }
    const reset = { up_to: prior?.up_to ?? "", dry_up_to: prior?.dry_up_to ?? "" };

    const why = ineligibleReason({ installRoot, registration, env, platform: hostPlatform, ...(readMode ? { readMode } : {}) });
    if (why) { save(seat, { ...reset, state: "ineligible", reason: why, mode, unread: 0, attempts: 0, next_try_at: null }); return; }
    const bash = findBash({ platform: hostPlatform, env });
    if (!bash) { save(seat, { ...reset, state: "unaddressable", reason: "bash_unavailable", mode, next_try_at: null }); return; }

    let driver;
    try { driver = readDriver(paths.configPath); } catch { driver = { state: "unreadable", reason: "storage_config_unreadable" }; }
    if (driver.state !== "ok" || driver.driver !== "sqlite") {
      save(seat, { ...reset, state: "blocked", reason: driver.state !== "ok" ? driver.reason : "storage_driver_unsupported", mode });
      return;
    }
    let any;
    let fresh;
    try {
      const store = openStore(messageStorePath({ storageDir: paths.storageDir, team, teamConfig }));
      try {
        any = readSnapshot(store, team, agent, "");
        fresh = readSnapshot(store, team, agent, live ? reset.up_to : reset.dry_up_to || reset.up_to);
      } finally { try { store.close(); } catch { /* keep the read result */ } }
    } catch (error) {
      save(seat, { ...reset, state: "blocked", reason: failure(error).replace("nudge_failed", "message_store_unreadable"), mode });
      return;
    }
    const unread = any.unread ? 1 : 0;
    if (!fresh.unread) {
      // Nothing new since the last notice (or nothing unread at all).
      // An unconfirmed Enter stays visible until a later notice goes through.
      if (isUnconfirmed(prior?.reason)) { save(seat, { ...reset, state: "blocked", reason: prior.reason, mode, unread, attempts: 0, next_try_at: null }); return; }
      const state = prior?.state === "delivering" && unread ? "delivering" : "idle";
      save(seat, { ...reset, state, reason: state === "idle" ? "" : prior.reason, mode, unread, attempts: 0, next_try_at: null });
      return;
    }
    if (prior?.next_try_at && Date.parse(prior.next_try_at) > now()) { save(seat, { state: prior.state, reason: prior.reason, mode, unread }); return; }

    // Re-check: a switch removed while this seat was being read must not be
    // overtaken by a run started from the earlier value.
    if (!deliveryEnabled(installRoot) || liveEnabled(installRoot) !== live) return;
    const text = inboxNudge(newNonce());
    // Durable, before anything can be typed (and while the poll is still active): "this cursor may be
    // typed now". Cleared when the run reports back; a later poll reconciles it if it never does.
    if (live) save(seat, { state: prior?.state ?? "idle", reason: prior?.reason ?? "", mode, inflight_up_to: fresh.upTo });
    const stages = {};
    const result = await run({
      script, mode, team, agent, text, signal, env, platform: hostPlatform, bash, stages,
      // Live only: the moment the line is typed, count it as notified and mark it unconfirmed. This
      // is written while the poll is still active, so a stop or deadline after typing cannot lose it.
      ...(live ? { onTyped: () => {
        outcomes.set(seat, { upTo: fresh.upTo, typed: true });
        save(seat, { state: "blocked", reason: "enter_unconfirmed", mode, up_to: fresh.upTo, dry_up_to: reset.dry_up_to, last_nudge_at: iso(now()), would_send: null, unread, attempts: 0, next_try_at: null, inflight_up_to: "" });
      } } : {}),
    });
    if (result.kind === "cancelled") {
      // The poll's scope is over: nothing can be written now. The in-flight record stays; remember in
      // memory whether the typed marker was seen. Not seeing it does not prove nothing was typed (the
      // marker comes after the typing); it is the only evidence this process has, and a restart loses it.
      if (live) outcomes.set(seat, { upTo: fresh.upTo, typed: Boolean(result.typed) });
      return;
    }
    // One line per finished run: what happened and when, in milliseconds since the spawn. Numbers and fixed words only,
    // never the notice, a path or any message text.
    const record = (reason) => {
      try {
        // An expired poll scope cannot publish late writes: a diagnostic line is a write too.
        assertPollActive();
        log(JSON.stringify({ event: "nudge_run", channel: CHANNEL_NAME, seat, mode, result: result.kind, code: Number.isInteger(result.code) ? result.code : null, typed_ms: stages.typedMs ?? null, checks: stages.checks ?? 0, last_check_ms: stages.lastCheckMs ?? null, total_ms: stages.totalMs ?? null, wrapper_ms: stages.wrapperMs ?? {}, peeks_ms: stages.peeksMs ?? [], seen_ms: stages.seenMs ?? {}, peek_seen_ms: stages.peekSeenMs ?? [], reason }));
      } catch { /* the record is an observation; it never changes the outcome */ }
    };
    const exit = result.kind === "exit" ? classifyExit(result.code)
      : result.kind === "timeout" ? { state: "blocked", reason: "nudge_timeout", backoff: true }
        : { state: "blocked", reason: "nudge_failed", backoff: true };
    // Live, typed, but not confirmed submitted (Enter failed, or the run was cut short after
    // typing): count it as notified so the line is never typed a second time, and say so.
    if (live && !exit.sent && (exit.typed || result.typed)) {
      const unconfirmed = unconfirmedReason(result.reasonWord, result.kind);
      record(unconfirmed);
      save(seat, { state: "blocked", reason: unconfirmed, mode, up_to: fresh.upTo, dry_up_to: reset.dry_up_to, last_nudge_at: iso(now()), would_send: null, unread, attempts: 0, next_try_at: null, inflight_up_to: "" });
      return;
    }
    if (exit.sent) {
      record(live ? "nudged" : "would_send");
      const at = iso(now());
      if (live) save(seat, { state: "delivering", reason: "nudged", mode, up_to: fresh.upTo, dry_up_to: reset.dry_up_to, last_nudge_at: at, would_send: null, unread, attempts: 0, next_try_at: null, inflight_up_to: "" });
      else save(seat, { state: "dry_run", reason: "would_send", mode, up_to: reset.up_to, dry_up_to: fresh.upTo, last_dry_at: at, would_send: text, unread, attempts: 0, next_try_at: null });
      return;
    }
    const attempts = (prior?.attempts ?? 0) + 1;
    let { state, reason } = exit;
    if (exit.counts && attempts >= UNCONFIRMED_LIMIT) { state = "blocked"; reason = "input_box_unconfirmed"; }
    const wait = exit.recheckMs ?? (exit.backoff ? backoffMs(attempts) : 0);
    record(reason);
    save(seat, { ...reset, state, reason, mode, unread, attempts, next_try_at: wait ? iso(now() + wait) : null, inflight_up_to: "" });
  }

  async function pollOnce({ signal } = {}) {
    if (stopped || !deliveryEnabled(installRoot)) return;
    if (activePoll) return activePoll;
    const operation = (async () => {
      let roster;
      try { roster = listSeats(join(installRoot, "teams")); } catch { roster = { state: "unreadable", reason: "team_roster_failed" }; }
      if (roster.state !== "ok") { log(`channel: Antigravity roster unavailable (${roster.reason})`); return; }
      if (!schemaReady) {
        assertPollActive();
        withImmediateTransaction(db, () => {
          db.exec(ANTIGRAVITY_NUDGE_SCHEMA);
          // A table made before the in-flight record existed gains the column.
          if (!db.prepare("PRAGMA table_info(beta_antigravity_nudge)").all().some((column) => column.name === "inflight_up_to")) {
            db.exec("ALTER TABLE beta_antigravity_nudge ADD COLUMN inflight_up_to TEXT NOT NULL DEFAULT ''");
          }
        });
        schemaReady = true;
      }
      const paths = {
        storageDir: env.AGMSG_STORAGE_PATH || join(installRoot, "db"),
        configPath: env.AGMSG_CONFIG || join(homedir(), ".agents", "agmsg", "config.json"),
      };
      const keep = new Set();
      const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
      for (const registration of roster.seats) {
        if (stopped || combined.aborted) return;
        keep.add(seatKey(registration.team, registration.agent));
        try { await pollSeat(registration, paths, combined); } catch (error) {
          if (combined.aborted) return;
          save(seatKey(registration.team, registration.agent), { state: "blocked", reason: failure(error), mode: liveEnabled(installRoot) ? "live" : "dry" });
        }
      }
      for (const { seat } of db.prepare("SELECT seat FROM beta_antigravity_nudge").all()) {
        if (keep.has(seat)) continue;
        assertPollActive();
        withImmediateTransaction(db, () => db.prepare("DELETE FROM beta_antigravity_nudge WHERE seat = ?").run(seat));
        lastSeen.delete(seat);
      }
    })().finally(() => { if (activePoll === operation) activePoll = null; });
    activePoll = operation;
    return operation;
  }

  return {
    name: CHANNEL_NAME,
    pollOnce,
    async stop() { stopped = true; lifetime.abort(); await activePoll; },
  };
}

// For status.mjs (the db is opened read-only).
export function readAntigravityNudge(db, installRoot) {
  if (!deliveryEnabled(installRoot)) return { enabled: false, live: false, state: "disabled", seats: [] };
  const live = liveEnabled(installRoot);
  try {
    return { enabled: true, live, state: "ok", seats: db.prepare("SELECT * FROM beta_antigravity_nudge ORDER BY seat").all() };
  } catch (error) {
    if (!String(error?.message ?? "").includes("no such table")) throw error;
    return { enabled: true, live, state: "unavailable", reason: "no_poll_recorded_yet", seats: [] };
  }
}

function age(fromIso, nowMs) {
  const seconds = Math.max(0, Math.round((nowMs - Date.parse(fromIso)) / 1000));
  return seconds < 120 ? `${seconds}s` : seconds < 7200 ? `${Math.round(seconds / 60)}m` : `${Math.round(seconds / 3600)}h`;
}

export function formatAntigravityNudge(observation, nowMs = Date.now()) {
  if (!observation?.enabled) return "";
  const head = observation.live ? "agmsgd delivering" : "agmsgd DRY-RUN (types nothing)";
  if (observation.state !== "ok") return `Antigravity delivery is on (${observation.live ? "live" : "dry-run"}), but the daemon has not recorded a poll yet\n`;
  let text = "";
  for (const row of observation.seats) {
    let label;
    try { label = JSON.parse(row.seat).join("/"); } catch { label = "unidentified seat"; }
    const parts = [];
    if (row.last_nudge_at) parts.push(`last nudge ${age(row.last_nudge_at, nowMs)} ago`);
    if (row.last_nudge_at && row.unread) parts.push(`still unread ${age(row.last_nudge_at, nowMs)} after the last nudge`);
    if (row.last_dry_at) parts.push(`last dry-run ${age(row.last_dry_at, nowMs)} ago`);
    if (row.would_send) parts.push(`would have typed: ${row.would_send}`);
    if (row.attempts) parts.push(`${row.attempts} refused in a row`);
    text += `Antigravity ${label}: ${head}: ${row.state}${row.reason ? ` (${row.reason})` : ""}${parts.length ? `; ${parts.join("; ")}` : ""}\n`;
  }
  return text || `Antigravity delivery is on (${observation.live ? "live" : "dry-run"}); no Antigravity seat is registered\n`;
}
