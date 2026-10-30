# agmsgd notices for Antigravity (agy): observation and nudge channels

Status: experimental, off by default. Both channels are additions; the Claude Code and Codex channels, `agmsg delivery`
for those types, and the Antigravity monitor / turn modes are unchanged.

agmsgd never delivers message bodies. For an Antigravity seat it can type ONE fixed line into the seat's pane
(`[agmsg:<nonce>] New messages are waiting. Check your agmsg inbox.`); the agent reads its own inbox, and that read marks
messages read. agmsgd does not write the message store, read cursors, role-session records or rule files.

## Switches (files under `run/`)

| File | Effect |
|---|---|
| `observe-antigravity` | The observation channel records each Antigravity seat (delivery mode, supervisor presence and phase) and `agmsg daemon status` shows it. Types nothing. |
| `agmsgd-antigravity-delivery` | The nudge channel runs in **dry-run**: every check reads the real screen, nothing is typed, and the line that would have been typed is recorded. `agmsg daemon offer antigravity` also stops saying "unavailable". |
| `agmsgd-antigravity-live` | Together with the delivery file, the nudge channel really types. The live file alone does nothing. |

A seat is nudged only when all of these hold (re-read on every poll): its project explicitly chose `agmsgd` in
`run/delivery-choice`; no supervisor reservation exists (either file format, even a stale one); its rule file is not the
monitor marker; the delivery file exists. `agmsg delivery agmsgd --type antigravity` writes the turn rule (never the
monitor rule, which tells agy not to read its inbox) and refuses while a monitor runs or a batch is unresolved.

## What the daemon does with the pane

It runs `scripts/daemon/agy-nudge.sh`, which uses the same pane path as `poke.sh` (placement record, terminal driver,
`safe-poke` with the confirmation-screen guard) without poke's agmsg-message fallback. Exit codes become seat states:
14 draft and 15 input box not confirmed back off (15 blocks after 10 in a row); 16 confirmation screen is not retried
(re-judged once a minute); 10/12/13 and a missing placement are `unaddressable`. Only a pane on the daemon's own host is
reachable; an environment aiming the terminal manager at another machine gives `remote_pane_unsupported`.

After typing, for herdr on Windows (`AGMSG_AGY_NUDGE_ENTER=auto`) no Enter is sent. The wrapper looks for the line's
token in the conversation (outside the located input box) and otherwise exits 23 with one reason word
(`box_has_line`, `box_empty`, `box_mismatch`, `confirmation_screen`, `box_unlocated`, `peek_failed`,
`enter_send_failed`), shown as `enter_unconfirmed:<word>`. A run that is stopped at its time limit after typing (25 s on
Windows, 10 s elsewhere) is shown as `enter_unconfirmed:timeout`, or `enter_unconfirmed:timeout:<word>` if the wrapper had
already printed a word; a plain `enter_unconfirmed` means typed with the outcome unknown (for example the run was cut off by
a stop). `enter_unconfirmed` is a statement about the check, not about delivery: the agent may well have received the
line (the check can be cut short while the agent is already working). Each run that ends inside its poll also writes one `nudge_run` line
to the daemon log (a run cancelled by the poll's deadline or a stop is not recorded: an expired poll cannot publish late
writes, so a missing `nudge_run` is not evidence that nothing ran) with fixed words and milliseconds since the spawn only (`result`, `code`, `typed_ms`, `checks` = how many
delivery checks started, `last_check_ms`, `total_ms`, `reason`), never the notice or any message text. The same line also carries where the wrapper's time went, as numbers only:
`wrapper_ms` (`libs`, `resolved`, `poked`), `peeks_ms` (each screen read, in order: the two safety reads, then the delivery checks)
and, on the daemon's own clock, `seen_ms` and `peek_seen_ms` (when each mark reached the daemon). The wrapper's clock starts at
its first statement, so the time Git Bash needed to start is not in `wrapper_ms` (the daemon's `seen_ms` is the only view of it, and
the two clocks are not subtracted from each other); it is the wall clock (`$EPOCHREALTIME` when bash has it, else `date +%s%3N`,
which starts a process per reading; neither the cost nor the effect on the timings has been measured) and can be stepped by a time
correction. A run refused early (a draft, a confirmation screen, an unclear box) shows only the stages it reached, and a dry run
shows the safety reads and the no-op poke, not the delivery checks. The marks are for measurement only: no limit, deadline or
delivery decision uses them. Delivery is best-effort: neither exactly-once nor at-least-once is guaranteed, so a notice can appear twice or not at
all. Once the daemon has observed the wrapper's "typed" marker, the line counts as notified and is not typed again (a
durable in-flight record is written before every live run). The marker is printed after the typing, so a run that is cut
off before the daemon has seen it cannot be told apart from one that never typed: if the daemon process that saw the
interruption is still the same one, the seat is retried (the line may then appear twice); after a daemon restart an
in-flight record is treated as "may have been typed", the cursor moves on and it is not retried
(`interrupted_unconfirmed`), so a notice that was never typed is lost until the next message arrives. `AGMSG_AGY_NUDGE_ENTER=always` additionally sends
one Enter if the box holds exactly the line and no confirmation screen shows; `off` skips the check.

## Measured behaviour and limits

Facts below were observed in October 2026 with Antigravity CLI 1.4.10, herdr 0.9.3 on Windows 11 (Git Bash), using a
throwaway project, team and seat, started from one particular shell setup. Each "fact" holds for that setup only; they are
not general statements about the products. Anything not observed is marked as a hypothesis.

- Fact: `herdr agent prompt` on an agy pane submits by itself; the line appeared in the conversation and was answered.
  `herdr pane send-text` on an ordinary shell pane only places text; Enter is needed there.
- Fact (live, 3 runs each): idle 3/3 delivered and read; a draft in the box 3/3 not typed; a permission screen showing
  3/3 not typed; no mixed-in text, no duplicate notice.
- Fact: with a long answer being generated, two runs typed the line while generation was in progress (agy queued it and
  handled it afterwards). In two runs where the live file was already present, the line was typed only after generation had ended: about
  45 s or more after the end of generation, and roughly 65 to 75 s after the message arrived (times read from
  screen captures taken every 10 to 15 s, so approximate), with no state change logged in between. Hypothesis: the poll during generation could not
  confirm the input box and backed off.
- Fact: one nudge takes about 10 s on Windows (Git Bash start-up plus local terminal-manager calls), so the run limit
  is 25 s there and 10 s elsewhere. Through `herdr --machine`, one call took 13 to 22 s; remote panes are unsupported.
- Fact (this setup): the agent ran commands through PowerShell, so in some runs it first tried a bare `bash`, failed, and
  retried with the full path; each attempt asked for permission separately.
- Fact (this setup): inside agy, `inbox.sh` could not detect the caller type automatically (it failed with "caller type not
  detected from session env"); `check-inbox.sh antigravity <project>` passes the type explicitly and worked. Whether a
  manually exported variable would also work was not tried.
- Fact (this setup): the notice says "Check your agmsg inbox", and the agent ran an `agmsg` command found on its shell's
  PATH, which on the test machine was an installed shim outside the throwaway setup. Pointing the agent's `HOME` at a throwaway directory
  that holds its own `bin/agmsg` isolated this (done in the test shell only).
- Fact (this install): the agent's skill list showed the workspace's `.agents/skills/` entries and its built-in skills; the
  installed agmsg skill under `~/.agents/skills/` was not listed. Hypothesis: which skill wins on a name clash is not known.
- Not measured: an Enter on an empty agy input; other agy versions; other platforms for the Windows path; multi-seat
  hosts; a resident (Task Scheduler) daemon.
