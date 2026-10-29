// Observation-only view of Antigravity (agy) seats. agmsgd does NOT deliver to
// agy here: delivery stays with the monitor/turn modes of the antigravity
// driver. This channel only reads what already exists and records what it saw
// (team registrations, the project's rule file, the supervisor's record in
// run/). It does not open the message store: a WAL store creates its -shm file
// even for a read-only connection, which would be a write outside agmsgd's own
// files,
// so `agmsg daemon status` can show an agy seat next to the Claude Code and
// Codex ones.
//
// It never writes a message, a read cursor, a pane, a role-session record, a
// supervisor state file or a rule file, never starts a process, and has no send
// path at all (there is deliberately no `send` option to inject). The one place
// it writes is its own table in the daemon's install.db (beta_antigravity_seat),
// the same kind of status record the other channels keep, plus the daemon log
// line on a state change.
//
// Off unless the file run/observe-antigravity exists. Removing the file turns
// it off again without restarting the daemon; the channel then does nothing.

import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { assertPollActive } from "../poll-deadline.mjs";
import { logLine, deliveryEvent } from "../log.mjs";
import { withImmediateTransaction } from "../db.mjs";
import { seatKey } from "./codex-queue.mjs";

export const OBSERVE_FLAG = "observe-antigravity";
export const CHANNEL_NAME = "antigravity-observe";
const TYPE = "antigravity";
// Same value as hooks_file in the antigravity type.conf, and the marker line
// the driver's monitor mode writes (_delivery.sh).
const RULE_FILE = join(".agent", "rules", "agmsg.md");
const MONITOR_MARKER = "<!-- agmsg:antigravity:monitor -->";

export const ANTIGRAVITY_OBSERVE_SCHEMA = `
CREATE TABLE IF NOT EXISTS beta_antigravity_seat (
  seat TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('observed', 'unobservable')),
  reason TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  checked_at TEXT NOT NULL
);
`;

export function observeEnabled(installRoot) {
  try {
    const stat = lstatSync(join(installRoot, "run", OBSERVE_FLAG));
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

export function encodeName(value) {
  return [...Buffer.from(value, "utf8")].map((byte) => {
    const char = String.fromCharCode(byte);
    return /^[A-Za-z0-9._-]$/.test(char) ? char : `%${byte.toString(16).padStart(2, "0").toUpperCase()}`;
  }).join("");
}

function readJsonFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_000_000) throw new Error("not_regular_file");
  return JSON.parse(readFileSync(path, "utf8"));
}

// Roles whose registration names antigravity. A team whose roster cannot be read
// is listed under `skipped` and does not hide the others.
export function listAntigravityRegistrations(teamsDir) {
  let entries;
  try {
    entries = readdirSync(teamsDir, { withFileTypes: true });
  } catch (error) {
    return error?.code === "ENOENT" ? { state: "ok", seats: [], skipped: [] } : { state: "unreadable", reason: "team_roster_unreadable" };
  }
  const seats = [];
  const skipped = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) { skipped.push({ team: entry.name, reason: "team_roster_symlink" }); continue; }
    if (!entry.isDirectory()) continue;
    let config;
    try {
      config = readJsonFile(join(teamsDir, entry.name, "config.json"));
    } catch (error) {
      if (error?.code !== "ENOENT") skipped.push({ team: entry.name, reason: "team_roster_malformed" });
      continue;
    }
    if (!config || typeof config !== "object" || !config.agents || typeof config.agents !== "object" || Array.isArray(config.agents)) {
      skipped.push({ team: entry.name, reason: "team_roster_malformed" });
      continue;
    }
    for (const [agent, value] of Object.entries(config.agents)) {
      const registrations = Array.isArray(value?.registrations) ? value.registrations : [];
      const projects = registrations.filter((item) => item?.type === TYPE).map((item) => item.project);
      if (projects.length) seats.push({ team: entry.name, agent, teamConfig: config, projects });
    }
  }
  return { state: "ok", seats, skipped };
}

// Linux only: the process start time as /proc reports it. Anything else is
// "unknown", never a guess. Read-only; no process is signalled or spawned.
export function readProcessStart(pid) {
  if (process.platform !== "linux") return undefined;
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").slice(1).join(") ").split(" ")[19];
  } catch (error) {
    return error?.code === "ENOENT" ? null : undefined;
  }
}

// How the seat's project says agy is delivered: monitor (marker), turn (some
// other rule file), or none. Several registered projects: a monitor marker in any wins.
export function readDeliveryMode(projects) {
  let mode = "none";
  for (const project of projects) {
    if (typeof project !== "string" || !project) continue;
    try {
      const text = readFileSync(join(project, RULE_FILE), "utf8");
      if (text.split(/\r?\n/).includes(MONITOR_MARKER)) return "monitor";
      mode = "turn";
    } catch { /* an absent rule file is "none" */ }
  }
  return mode;
}

// The supervisor/bridge record for this seat, read from run/. Reports presence,
// liveness and coarse progress only; message ids and bodies are never copied.
export function readSupervisor(runDir, team, agent, procStart = readProcessStart) {
  const key = `${encodeName(team)}__${encodeName(agent)}`;
  let reservation;
  for (const name of [`read-reservation.${key}.json`, `antigravity-reservation.${key}.json`]) {
    try { reservation = readJsonFile(join(runDir, name)); break; } catch (error) {
      if (error?.code !== "ENOENT") return { presence: "unreadable" };
    }
  }
  if (!reservation) return { presence: "absent" };
  if (reservation.type !== TYPE) return { presence: "absent" };
  const result = { presence: "present", kind: reservation.kind === "tui-pty" ? "tui-pty" : "headless", live: "unknown" };
  const pid = Number(reservation.pid);
  if (Number.isInteger(pid) && pid > 0 && typeof reservation.start === "string") {
    const start = procStart(pid);
    result.live = start === undefined ? "unknown" : start === reservation.start ? "yes" : "no";
  }
  try {
    // Resolve symlinks in every component before comparing, so a link inside
    // run/ cannot lead the read outside it.
    const realRun = realpathSync(runDir);
    const statePath = realpathSync(String(reservation.state ?? ""));
    if (!statePath.startsWith(realRun + sep)) throw new Error("outside_run");
    const state = readJsonFile(statePath);
    if (state.team === team && state.role === agent) {
      if (/^[A-Z_]{1,32}$/.test(state.supervisorPhase ?? "")) result.phase = state.supervisorPhase;
      const batch = state.batch?.phase;
      if (["prepared", "sent", "completed", "uncertain"].includes(batch)) result.batch = batch;
      result.paused = Boolean(state.humanInputActive || state.manualResumeRequired);
      result.attention = Boolean(state.durableAttention);
    }
  } catch { /* a missing state file leaves only presence and liveness */ }
  return result;
}

// Pure classification of what was seen; unit-testable without a filesystem.
export function classifySeat({ mode, supervisor }) {
  const detail = { mode, supervisor: supervisor.presence === "present" ? (supervisor.live === "yes" ? "running" : supervisor.live === "no" ? "stopped" : "unknown") : supervisor.presence };
  if (supervisor.kind) detail.kind = supervisor.kind;
  for (const field of ["phase", "batch", "paused", "attention"]) if (supervisor[field] !== undefined) detail[field] = supervisor[field];
  let reason;
  if (mode === "monitor") {
    // "Not running" only when the record is absent or names a process that is
    // gone. A record that cannot be read or checked is not evidence of a stop.
    if (detail.supervisor === "running") reason = detail.attention ? "monitor_needs_attention" : detail.paused ? "monitor_paused" : "monitor_running";
    else reason = detail.supervisor === "absent" || detail.supervisor === "stopped" ? "monitor_not_running" : "monitor_liveness_unknown";
  } else {
    reason = mode === "turn" ? "turn_mode" : "no_delivery_mode";
  }
  return { state: "observed", reason, detail };
}

function saveSeat(db, { seat, state, reason, detail = {} }, now) {
  assertPollActive();
  withImmediateTransaction(db, () => {
    db.prepare(`
      INSERT INTO beta_antigravity_seat (seat, state, reason, detail, checked_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(seat) DO UPDATE SET state=excluded.state, reason=excluded.reason, detail=excluded.detail, checked_at=excluded.checked_at
    `).run(seat, state, reason, JSON.stringify(detail), new Date(now()).toISOString());
  });
}

export function createAntigravityObserveChannel({
  db,
  installRoot,
  now = Date.now,
  log = (message) => logLine(installRoot, message),
  listSeats = listAntigravityRegistrations,
  procStart = readProcessStart,
}) {
  let stopped = false;
  let activePoll = null;
  let schemaReady = false;
  const lastSeen = new Map();

  // Reasons stored and logged are fixed words, never an error message (which
  // can carry a path). An errno code is kept when it has the usual shape.
  function failureReason(prefix, error) {
    return /^E[A-Z0-9]{2,15}$/.test(error?.code ?? "") ? `${prefix}:${error.code}` : prefix;
  }

  function observeSeat(registration) {
    const { team, agent, projects } = registration;
    return classifySeat({ mode: readDeliveryMode(projects), supervisor: readSupervisor(join(installRoot, "run"), team, agent, procStart) });
  }

  async function pollOnce({ signal } = {}) {
    if (stopped || !observeEnabled(installRoot)) return;
    if (activePoll) return activePoll;
    const operation = (async () => {
      let roster;
      try { roster = listSeats(join(installRoot, "teams")); } catch (error) { roster = { state: "unreadable", reason: failureReason("team_roster_failed", error) }; }
      if (roster.state !== "ok") { log(`channel: Antigravity roster unavailable (${roster.reason})`); return; }
      if (!schemaReady) {
        assertPollActive();
        withImmediateTransaction(db, () => db.exec(ANTIGRAVITY_OBSERVE_SCHEMA));
        schemaReady = true;
      }
      const results = new Map();
      for (const team of roster.skipped ?? []) results.set(seatKey(team.team, ""), { state: "unobservable", reason: team.reason });
      for (const registration of roster.seats) {
        if (stopped || signal?.aborted) return;
        let result;
        try { result = observeSeat(registration); } catch (error) { result = { state: "unobservable", reason: failureReason("observe_failed", error) }; }
        results.set(seatKey(registration.team, registration.agent), result);
      }
      for (const [seat, result] of results) {
        saveSeat(db, { seat, ...result }, now);
        const signature = `${result.state}|${result.reason}`;
        if (lastSeen.get(seat) !== signature) {
          lastSeen.set(seat, signature);
          deliveryEvent(log, { event: "seat_state", channel: CHANNEL_NAME, seat, reason: result.reason, state: result.state });
        }
      }
      for (const { seat } of db.prepare("SELECT seat FROM beta_antigravity_seat").all()) {
        if (results.has(seat)) continue;
        assertPollActive();
        withImmediateTransaction(db, () => db.prepare("DELETE FROM beta_antigravity_seat WHERE seat = ?").run(seat));
        lastSeen.delete(seat);
      }
    })().finally(() => { if (activePoll === operation) activePoll = null; });
    activePoll = operation;
    return operation;
  }

  return {
    name: CHANNEL_NAME,
    pollOnce,
    async stop() { stopped = true; await activePoll; },
  };
}

// For status.mjs (read-only; `db` is opened readonly). Returns the stored
// observation, or says why there is none.
export function readAntigravityObservation(db, installRoot) {
  if (!observeEnabled(installRoot)) return { enabled: false, state: "disabled", seats: [] };
  try {
    return { enabled: true, state: "ok", seats: db.prepare("SELECT seat, state, reason, detail, checked_at FROM beta_antigravity_seat ORDER BY seat").all() };
  } catch (error) {
    if (!String(error?.message ?? "").includes("no such table")) throw error;
    return { enabled: true, state: "unavailable", reason: "no_poll_recorded_yet", seats: [] };
  }
}

export function formatAntigravitySeats(observation) {
  if (!observation?.enabled) return "";
  if (observation.state !== "ok") return "Antigravity observation is on, but the daemon has not recorded a poll yet (observation only; agmsgd does not deliver to Antigravity)\n";
  let text = "";
  for (const row of observation.seats) {
    let label;
    let detail = {};
    try { label = JSON.parse(row.seat).join("/"); } catch { label = "unidentified seat"; }
    try { detail = JSON.parse(row.detail); } catch { /* shown without detail */ }
    const parts = [detail.mode && `mode ${detail.mode}`, detail.supervisor && `supervisor ${detail.supervisor}`, detail.phase && `phase ${detail.phase}`,
      detail.batch && `batch ${detail.batch}`].filter(Boolean);
    text += `Antigravity ${label}: observation only, agmsgd does not deliver here: ${row.reason}${parts.length ? ` (${parts.join(", ")})` : ""}\n`;
  }
  return text || "Antigravity observation is on; no Antigravity seat is registered (observation only)\n";
}
