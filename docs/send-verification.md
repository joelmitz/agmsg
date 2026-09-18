# Verifying a send

`send.sh` printing `Sent to <to> in team <team>` establishes one thing: a row was
written to the local store. Three different failures leave that line — and the
zero exit status — completely intact:

1. the body was damaged by **the caller's shell** before `send.sh` ever saw it;
2. the body was **truncated by the operating system's argument limit**;
3. the row was stored and **never pushed to the server**, so a member on another
   machine never receives it.

None of the three is visible from the sending side unless you look for it
specifically. This page says where to look.

## 1. A body passed as an argument crosses your shell first

The positional form takes the body as one argument, and the quoting you wrap it
in is interpreted by **your** shell — `send.sh` receives only the result.

**Double quotes are the dangerous form.** Measured 2026-08-02 by sending 46
messages into an isolated database and diffing what arrived against what was
sent:

| in the body | passed as `"…"` | passed as `'…'` |
|---|---|---|
| `$(…)` | **executed**; the span is replaced by its output | intact |
| `` `…` `` | **executed**; the span is replaced by its output | intact |
| `$VAR` | replaced by the value (empty when unset) | intact |
| a bare `$` | consumed | intact |
| `\` | consumed | intact |
| `"` | consumed | intact |

Nothing else in that set differed. `!` `*` `?` `[]` `;` `|` `&` `#` `%` `~`,
newlines, tabs, Japanese text, emoji, a leading hyphen and an 8 KB body all
arrived byte-identical under either quoting (`!` history expansion is
interactive-shell only). That run was on Linux; for the argument-length limit,
which is platform-dependent, see section 2.

Two consequences follow, and the second is the serious one.

**Nothing on the sending side shows it.** The send succeeds, and `history.sh`
shows the message carrying the same hole, so re-reading your own history
confirms nothing. Only the recipient sees a sentence with a gap in it.

**`$(…)` in a body you are relaying executes on your machine.** If you take text
someone else wrote and pass it through double quotes, that is arbitrary command
execution on the sending host, not a text-mangling problem. Single quotes, or
the paths below, close it.

### Keep the body off the command line

```bash
send.sh <team> <from> <to> --body-file <path>     # body read from a file
send.sh <team> <from> <to> --body -               # body read from stdin
```

`--body-file` is the strongest form: write the file with a file-writing tool
rather than with `cat`, `printf` or a heredoc, and the body never appears in a
command line at all. Only the path does. There is no quoting rule left to get
right.

A heredoc piped into `--body -` is equally safe, **but only if both** of these
hold:

| condition | if it does not hold |
|---|---|
| quote the heredoc delimiter — `<<'EOF'`, not `<<EOF` | `$( )`, backticks and `$VAR` inside the body are expanded |
| do not assemble the body in an outer shell (`bash -c '…'`) | the outer quoting is parsed first, and the inner `'EOF'` stops delimiting |

```bash
send.sh <team> <from> <to> --body - <<'EOF'
Backticks, $(command) and 'quotes' all arrive as written.
EOF
```

**Reaching `send.sh` through stdin is not by itself sufficient.** Text assembled
in an outer shell has already been expanded before it gets to stdin. Measured
2026-08-23: a body built inside `bash -c '…'` and piped in contained a line
reading `join.sh <team> <name> <name> …`, and that line was **executed instead of
sent** — it appended a membership event to a server's event stream that could not
be taken back.

Two habits follow from that incident:

- **Do not write a wrapper that interpolates a body into a double-quoted
  argument** (`send.sh … "$body"`). Whatever the wrapper's own quoting, it
  reintroduces exactly the expansion above, and long bodies additionally hit the
  argument limit in section 2.
- **In procedure documents, write command examples with placeholders**
  (`<team>`, `<from>`, `<to>`), not with real names. A line that was pasted or
  expanded by accident then cannot run: with every placeholder still in place,
  the shell reads `<` as a redirection and the command fails with a syntax error
  before doing anything. The dangerous state is a *partially* substituted line —
  the word after `>` becomes a filename — so substitute every placeholder before
  running anything.

Two smaller differences between the forms are worth knowing:

- single quotes cannot contain a `'`, which is why `--body -` and `--body-file`
  are the general answer rather than a fallback;
- `--body-file` and `--body -` strip trailing newlines from the body
  (command-substitution semantics, as in `poke`), while the positional form
  preserves them. If a trailing newline is load-bearing, use the positional form
  deliberately.

## 2. The argument limit truncates silently

A positional body also has to fit in the operating system's argument space.

Measured 2026-08-23 on Windows (Git Bash): a body **containing spaces**, passed
as a positional argument, is cut off at **8,186 bytes** — no error, no warning,
exit 0. Everything past that byte is gone, and again the sender sees nothing
wrong.

`--body-file` and `--body -` do not go through argv, so they are not subject to
this at all. It is a second, independent reason not to generate the positional
form for anything a program composed.

## 3. A stored message is not a delivered message

This section applies to a team connected to a remote. A local-only team has no
push step.

For a member on another machine, a send is two steps: the row lands in the local
store, and the **sync engine** pushes it to the server. If the engine is dead,
the first step still succeeds — and everything you would normally check says the
send was fine:

| what you check | with a dead engine |
|---|---|
| `send.sh` output | `Sent to <to> in team <team>` |
| `history.sh` | the message is there |
| a health check against the server or tunnel | answers normally |

The one place it shows is `remote.sh status`:

```bash
bash ~/.agents/skills/agmsg/scripts/remote.sh status <team>
```

```
<team>	connected (engine running, pid N) since <…>
		cycles: last successful sync <timestamp>
```

against, for a stalled one:

```
<team>	connected (engine stale — pidfile N points at a dead or foreign process; run: …) since <…>
<team>	connected (engine stopped — run: …) since <…>
```

Measured 2026-08-15: roughly 4.5 hours of silent non-delivery in both directions
after the machine holding an engine went down. The tunnel had been brought back,
which made every visible check pass, so nobody looked at the engine line.

### `engine running` is not proof of delivery either

The engine line reports that a local process is alive. `cycles:` narrows that —
it distinguishes an engine that has completed a cycle from one that never has
(#756) — but a completed cycle still does not establish that **your** message was
accepted by the server. The engine line is a necessary condition for delivery,
not a sufficient one.

For a specific message, look for the server's acknowledgement. The engine emits
`push.ack` carrying the `server_seq` and `disposition` the server assigned:

```
push.ack … {"acks":[{"id":"…","server_seq":"1584","disposition":"stored"}]}
```

Read it out of the engine's log rather than starting a second cycle:

```bash
tail -n 50 ~/.agents/skills/agmsg/run/remote-sync.<team>.log
```

`remote-sync.sh once --team <team>` runs a single cycle in the foreground and
prints the same events, which is useful when no engine is running. Alongside a
running engine it is an *extra* cycle, so prefer the log.

**Getting an engine running again does not by itself prove the backlog left.**
Confirm an ack that covers the message in question before treating the incident
as closed.
