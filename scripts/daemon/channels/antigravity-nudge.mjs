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

import { lstatSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
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
  checked_at TEXT NOT NULL
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

export function chosenAgmsgd(installRoot, projects) {
  if (!projects.length) return false;
  return projects.every((project) => {
    if (typeof project !== "string" || !project) return false;
    const names = new Set([project]);
    try { names.add(realpathSync(project)); } catch { /* an unreachable project keeps its literal name */ }
    return [...names].some((name) => readDeliveryChoice(installRoot, TYPE, name) === "agmsgd");
  });
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
export function ineligibleReason({ installRoot, registration, env }) {
  if (remoteTargetConfigured(env)) return "remote_pane_unsupported";
  if (!chosenAgmsgd(installRoot, registration.projects)) return "delivery_not_chosen";
  if (reservationTrace(join(installRoot, "run"), registration.team, registration.agent)) return "supervisor_present";
  if (readDeliveryMode(registration.projects) === "monitor") return "monitor_mode";
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
    default: return { state: "blocked", reason: "nudge_failed", backoff: true };
  }
}

function killGroup(child, signal) {
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch { try { child.kill(signal); } catch { /* already gone */ } }
}

// Runs agy-nudge.sh with the line on stdin. Output is read and dropped: it can
// carry paths and is never stored or logged.
export function runNudge({ script, mode, team, agent, text, timeoutMs = NUDGE_TIMEOUT_MS, signal, spawnProcess = spawn, env = process.env }) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve({ kind: "cancelled" }); return; }
    let child;
    try {
      child = spawnProcess("bash", [script, mode, team, agent, "--body", "-"], { env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    } catch { resolve({ kind: "failed" }); return; }
    let done = false;
    let stopping = null;
    const timers = [];
    const finish = (value) => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const hardStop = (kind) => {
      stopping ??= kind;
      killGroup(child, "SIGTERM");
      timers.push(setTimeout(() => { killGroup(child, "SIGKILL"); child.stdout?.destroy(); child.stderr?.destroy(); child.unref?.(); finish({ kind }); }, KILL_GRACE_MS));
    };
    const onAbort = () => hardStop("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    timers.push(setTimeout(() => hardStop("timeout"), timeoutMs));
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", () => {});
    child.once("error", () => finish({ kind: "failed" }));
    child.once("close", (code) => finish(stopping ? { kind: stopping } : code === null ? { kind: "failed" } : { kind: "exit", code }));
    child.stdin?.on("error", () => {});
    child.stdin?.end(text);
  });
}

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
}) {
  let stopped = false;
  let activePoll = null;
  let schemaReady = false;
  const lastSeen = new Map();
  const lifetime = new AbortController();
  const script = join(installRoot, "scripts", "daemon", "agy-nudge.sh");

  const iso = (ms) => new Date(ms).toISOString();
  const readRow = (seat) => db.prepare("SELECT * FROM beta_antigravity_nudge WHERE seat = ?").get(seat);

  function save(seat, fields) {
    assertPollActive();
    const row = { ...(readRow(seat) ?? {}), ...fields };
    withImmediateTransaction(db, () => {
      db.prepare(`
        INSERT INTO beta_antigravity_nudge (seat, state, reason, mode, up_to, dry_up_to, last_nudge_at, last_dry_at, would_send, unread, attempts, next_try_at, checked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(seat) DO UPDATE SET state=excluded.state, reason=excluded.reason, mode=excluded.mode, up_to=excluded.up_to, dry_up_to=excluded.dry_up_to,
          last_nudge_at=excluded.last_nudge_at, last_dry_at=excluded.last_dry_at, would_send=excluded.would_send, unread=excluded.unread,
          attempts=excluded.attempts, next_try_at=excluded.next_try_at, checked_at=excluded.checked_at
      `).run(seat, row.state, row.reason, row.mode ?? "dry", row.up_to ?? "", row.dry_up_to ?? "", row.last_nudge_at ?? null, row.last_dry_at ?? null,
        row.would_send ?? null, row.unread ?? 0, row.attempts ?? 0, row.next_try_at ?? null, iso(now()));
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
    const prior = readRow(seat);
    const reset = { up_to: prior?.up_to ?? "", dry_up_to: prior?.dry_up_to ?? "" };

    const why = ineligibleReason({ installRoot, registration, env });
    if (why) { save(seat, { ...reset, state: "ineligible", reason: why, mode, unread: 0, attempts: 0, next_try_at: null }); return; }
    if (hostPlatform === "win32") { save(seat, { ...reset, state: "unaddressable", reason: "platform_unsupported", mode, next_try_at: null }); return; }

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
      const state = prior?.state === "delivering" && unread ? "delivering" : "idle";
      save(seat, { ...reset, state, reason: state === "idle" ? "" : prior.reason, mode, unread, attempts: 0, next_try_at: null });
      return;
    }
    if (prior?.next_try_at && Date.parse(prior.next_try_at) > now()) { save(seat, { state: prior.state, reason: prior.reason, mode, unread }); return; }

    // Re-check: a switch removed while this seat was being read must not be
    // overtaken by a run started from the earlier value.
    if (!deliveryEnabled(installRoot) || liveEnabled(installRoot) !== live) return;
    const text = inboxNudge(newNonce());
    const result = await run({ script, mode, team, agent, text, signal, env });
    if (result.kind === "cancelled") return;
    const exit = result.kind === "exit" ? classifyExit(result.code)
      : result.kind === "timeout" ? { state: "blocked", reason: "nudge_timeout", backoff: true }
        : { state: "blocked", reason: "nudge_failed", backoff: true };
    if (exit.sent) {
      const at = iso(now());
      if (live) save(seat, { state: "delivering", reason: "nudged", mode, up_to: fresh.upTo, dry_up_to: reset.dry_up_to, last_nudge_at: at, would_send: null, unread, attempts: 0, next_try_at: null });
      else save(seat, { state: "dry_run", reason: "would_send", mode, up_to: reset.up_to, dry_up_to: fresh.upTo, last_dry_at: at, would_send: text, unread, attempts: 0, next_try_at: null });
      return;
    }
    const attempts = (prior?.attempts ?? 0) + 1;
    let { state, reason } = exit;
    if (exit.counts && attempts >= UNCONFIRMED_LIMIT) { state = "blocked"; reason = "input_box_unconfirmed"; }
    const wait = exit.recheckMs ?? (exit.backoff ? backoffMs(attempts) : 0);
    save(seat, { ...reset, state, reason, mode, unread, attempts, next_try_at: wait ? iso(now() + wait) : null });
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
        withImmediateTransaction(db, () => db.exec(ANTIGRAVITY_NUDGE_SCHEMA));
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
