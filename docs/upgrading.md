# Upgrading an install

`./install.sh --update` rewrites the scripts, templates and `SKILL.md` under the
install directory and preserves the DB and team configs. Two things around that
are easy to get wrong, and neither announces itself:

- the **version string** the install stamps comes from the clone you ran it
  from, not from the commit you believe you installed;
- **processes that were already running keep executing the old code** until
  something restarts them — and several of them go on looking healthy while
  they do.

## Installing from a fork: fetch the upstream tags first

`install.sh` derives the version it writes to `VERSION` by running
`git describe --match "v[0-9]*"` inside the clone it was invoked from
(`agmsg_source_version()`). `git describe` can only see the tags that clone
actually holds.

**A GitHub fork does not carry the upstream's tags.** Clone a fork and you get
its commits but not the release tags, so `describe` falls back to whatever older
tag is still reachable — and the *same commit* reports a different version
depending on which remote it was cloned from.

Measured 2026-08-22, two machines installing the identical commit `2bfa9c6`:

| clone | `git describe` |
|---|---|
| fork only | `v1.2.0-51-g2bfa9c6` (wrong) |
| after fetching the upstream tags | `v1.2.2-23-g2bfa9c6` |

So fetch the tags before installing:

```bash
git clone https://github.com/<fork-owner>/agmsg.git <dir>
cd <dir>
git remote add upstream https://github.com/fujibee/agmsg.git
git fetch upstream --tags
git describe --tags --match "v[0-9]*"   # expect the same string on every machine
```

**Do not use the version string to decide whether two machines run the same
code.** It is a snapshot of the clone at install time, not a property of the
commit. Compare commits. The same commit `29796d8` once read `v1.2.2-1-…` on one
machine and `v1.2.0-29-…` on another, entirely from this.

## What keeps running old code after `--update`

`--update` replaces files. Four long-lived processes can be running against the
old ones. Only the first is handled for you.

### 1. The sync engine — restarted for you, unless a supervisor owns it

`--update` snapshots which teams had a running engine *before* it rewrites
anything, and afterwards restarts each of them on the new code through
`remote.sh sync restart <team>` (#1288, fixes #963). Teams whose engine was not
running are left stopped. A restart that fails is reported with the command to
run by hand and does not abort the update.

This exists because the engine's own stand-down cannot be relied on for the
update that introduces it. The engine detects that the install changed by
comparing `scripts/` against a baseline taken **when the engine started**, so an
engine started before that detector existed does not have it. Measured
2026-08-23: after an update, an engine from the older code kept running
`pull.import` cycles and had to be restarted by hand.

**An engine held by an external supervisor is deliberately not touched.** When a
systemd user unit owns the team, both `sync start` and `sync restart` refuse:

```
agmsg: systemd owns team '<team>'; inspect or restart the user unit instead of sync restart
```

Restart it through the supervisor that owns it, and confirm afterwards. Note
that `engine stale` immediately after an update is not by itself proof that a
restart failed — check `remote.sh status <team>` before concluding anything, and
see [send-verification.md](send-verification.md) for what that line does and does
not establish.

### 2. The Claude Code watcher — always stops, and nothing restarts it

`watch.sh` takes a stamp when it starts and, at the top of every poll cycle,
checks whether anything under `scripts/` was written after it (#684). Anything at
all counts — writing a single file is enough. When it sees a change it exits
rather than serve from stale code, and says so on stdout:

> the agmsg installation was updated while this watcher was running, so it is
> still executing the code from before the update. Exiting rather than appearing
> to work. Restart this session (or run `/agmsg actas <name>`) to resume
> delivery.

So **every update stops delivery for that session**, and nothing brings it back
on its own. Fold that into the update procedure instead of discovering it when
a message does not arrive.

**Restarting the session is the surest route, but it is not the only one.**
Before reaching for either, split the two things that can be missing — they have
different fixes:

```bash
bash ~/.agents/skills/agmsg/scripts/delivery.sh status claude-code "$(pwd)"
```

```
mode: monitor
  SessionStart entries: 1     <- 0 means the hook registration is gone
  SessionEnd entries:   1
watch processes: 0 alive      <- 0 means only the watcher died
```

| what is missing | what to do |
|---|---|
| the hook registration | `delivery.sh set monitor claude-code "$(pwd)"` |
| the watcher only | `delivery.sh restart claude-code "$(pwd)"` |

`restart` takes `<type> <project_path>` in that order, and **does not spawn a
watcher itself**. It prints an `AGMSG-DIRECTIVE` naming the command and
description for the host agent to run through its own Monitor tool
(`persistent: true`). Pass those through verbatim, then re-run `status` and
expect `1 alive`.

Measured 2026-08-19: the hook registration had survived (1 / 1) and only the
watcher was gone. The update's output warns that an upgrade *can* drop the
SessionStart/Stop hooks; that is not the same as saying it did. Check first,
rather than re-running `set` reflexively.

### 3. A Codex seat — first find out how this project is delivered

What to check depends on the delivery the **project** uses, not on whether
agmsgd is on: agmsgd can be on while a project has chosen `monitor` (legacy),
`turn` or `off`. Settle that first, from the project directory or with
`--project`:

```bash
agmsg delivery status --type codex --project "<project>"
```

The first line of the output is the install-wide agmsgd state; the line that
starts with `this project:` is what **this project** chose. Read both:

| First line (install-wide) | `this project:` line | What it means | Go to |
|---|---|---|---|
| `delivery: agmsgd (on) — notices are delivered directly` | `this project: agmsgd — no Monitor is armed here; ...` | agmsgd is running and delivers here | 3a |
| `delivery: agmsgd (on, but not running: <reason>) — start it with: agmsg delivery agmsgd` | `this project: agmsgd — ...` | this project is set to agmsgd, but agmsgd is **not running, so nothing is delivered right now** | start agmsgd as the line says, then run this check again. **Exception:** if the reason says `the executor runs in another pid namespace (a sandbox)`, agmsgd may well be running and this command only cannot see it: do not start it from here, and run the check from an ordinary shell outside the sandbox |
| `delivery: agmsgd (off) — available; ...` or `delivery: agmsgd (unavailable) — <reason>` | `this project: agmsgd — ...` | this project is set to agmsgd, but agmsgd is **turned off or unavailable, so nothing is delivered** | turn it on as the line says (or read the reason), then run this check again |
| any | `this project: monitor (legacy)` (with or without `chosen — agmsgd does not deliver here`) | the bridge delivers here | 3b |
| any | `this project: turn chosen — agmsgd does not deliver here`, `this project: off chosen — agmsgd does not deliver here`, or a bare `this project: turn` / `this project: off` | neither a bridge nor agmsgd delivers here | nothing to restart for this update |

`this project: agmsgd` by itself never means that agmsgd is delivering: it is
printed when the project chose agmsgd even while agmsgd is stopped. Treat the
project as delivered by agmsgd only when the first line says `(on)`.

#### 3a. The project uses agmsgd

Only once the first line above says `(on)`. There is no bridge to restart.
Codex runs as plain Codex and agmsgd delivers
through the destination record the seat wrote when it picked its role.
`--update` restarts agmsgd itself when it was on. To see that it is running and
what it recorded for each seat, use:

```bash
agmsg daemon status
```

Expect `agmsgd is running (gen ..., version ...)` and, for the seat,
`Codex <team>/<agent>: destination recorded`. If the seat line says
`no destination record; restart Codex and run actas again to record it`, close
Codex, start it again, and in the first turn pick the role again
(`$agmsg actas <name>`). A session that still has a bridge from before agmsgd
was enabled keeps using that bridge until it is restarted: the seat line then
says `bridge process running; reopen Codex to switch to agmsgd`, and agmsgd
skips that session meanwhile. Restarting Codex ends that state.

Run `agmsg daemon status` from an ordinary shell, not from inside a Codex
sandbox. A command in another pid namespace cannot see agmsgd and says so
(`agmsgd cannot be checked from here ...`); that is not a sign that agmsgd is
down, and the message tells you not to stop or start it from there.

#### 3b. The project uses the monitor (legacy)

The bridge is a process of the Codex session. Running `--update` against a
session that is already open does not switch it to the new code.

**`delivery.sh restart codex <project>` is not the way to do it.** That command
asks *the session you are running it in* to launch a codex-type watcher; it does
not reach into another session's bridge.

Close the Codex TUI and start it again through whichever entry point this
install set up — the shell function that `delivery.sh set monitor codex
<project>` printed, the PATH shim, or `codex-monitor.sh`
(see [codex-monitor-beta.md](codex-monitor-beta.md)). Then, in the first turn,
pick the role again so the seat is recorded, and confirm from another shell
(the output ends with the `Codex bridge: ...` lines for the project):

```bash
agmsg delivery status --type codex --project "<project>"
```

#### Both cases

The Codex SessionStart hook fires on the **first turn**, not when the TUI opens.
A missing bridge or destination record in the moment after launch is not a
failure. Do not read `run/` state, threads or metadata directly to infer or
rewrite a seat; when several threads make the seat ambiguous, stop and report
rather than adopting a guess.

### 4. agmsgd that cannot be checked from this environment

`agmsg daemon offer` reports `agmsgd=unchecked` when the current environment
cannot inspect the daemon process, including when it runs in another pid
namespace. The daemon may still be running. Do not treat this as stopped and do
not run `agmsg delivery agmsgd`, `agmsg daemon start`, or `agmsg daemon stop`
here. Check delivery from an environment that can inspect the daemon; keep the
project's configured delivery unchanged until then.

## After the update

- Verify what you restarted, rather than assuming the restart took:
  `remote.sh status <team>`, `delivery.sh status <type> <project>`.
- Re-run `delivery.sh set <mode> <type> <project>` in any project whose
  SessionStart/Stop hook entries were in fact dropped.
- When upgrading more than one machine, do them one at a time and confirm the
  first before starting the second.
