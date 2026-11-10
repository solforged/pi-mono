# Intercom

The `intercom` extension lets separate top-level Pi sessions on this machine
send each other short notes, for example to coordinate two sessions editing
the same repository. It is a Pi port of `omp-intercom`, using Rex where that
uses Tern. Delegated children (`subagent`, `rex_agent`) are reached through
their own tools instead.

## Use

People use `/intercom`:

| Command | Effect |
|---|---|
| `/intercom` or `/intercom list` | List this session and the other listening sessions. |
| `/intercom <to> <message>` | Send a quiet note. |
| `/intercom <to> --aside <message>` | Send a note that reaches a busy receiver at its next step. |
| `/intercom status <to>` | Ask whether the session is busy, and show its last reply. |
| `/intercom peek <to> [lines]` | Show the end of the session's Rex pane (default 40 lines). |
| `/intercom focus <to>` | Bring the session's Rex pane into view. |

`<to>` is an intercom id, a Pi session id, a working-directory path (`~`
allowed), a folder name, or part of the session title, tried in that order.
Ambiguous names fail rather than guessing. The command target must be one
whitespace-free token; the tool also accepts names containing spaces.

Agents use the `intercom` tool with `action` set to `list`, `status`, or
`send` (`to`, `message`, and optional `aside: true`). Peek and focus are left
out of the tool to keep its declaration under 480 characters. A regression
check enforces that limit. The tool is [deferred](deferred-tools.md):
`tool_search` loads it, and an arriving note declares it straight away.

## Delivery

- A **quiet** note is delivered as a Pi follow-up: it waits until the
  receiver's current run ends, then starts a turn. An idle receiver starts a
  turn at once.
- An **aside** is delivered as a steering message, after the receiver's
  current tool calls and before its next model call.
- A quiet note to a busy session from a peer it wrote to in the last 30
  minutes is treated as the **reply** it is waiting for and delivered as an
  aside. Without this, an answer would wait for the asker's whole run and
  arrive after it had moved on.
- Any other quiet note to a busy session is **queued**. The receiving model
  is told it waited, so it may predate the work done since.
- The sender's answer says which of these happened: a turn started, the note
  arrives at the next step, or it waits for the current run. Delivery means Pi
  accepted the note, not that the agent acted on it. Cards show `(reply)`,
  `(queued)` or `(held)` beside the sender.
- The receiver's model sees the note inside an `<intercom from="…">` block,
  followed by a line marking it as a peer's note rather than the user's
  instruction. The peer's text cannot close that block.
- Peers may start at most 10 turns in a session before its user speaks again.
  Later notes are held for the user's next prompt, and both sides are told.
  This stops two agents from answering each other indefinitely.

## Listeners

Interactive and RPC top-level sessions listen. Print and JSON runs, Rex
children and workflow subagents do not. Each listening process keeps one
intercom id across `/reload`, `/new` and `/resume`.

Listeners live in `<agent-dir>/intercom/`, an owner-only directory holding a
Unix socket and a JSON card (`0600`) per process. Cards hold the id, process
id, working directory, session id and title, busy flag, and Rex session and
block; no transcript content. Cards of exited processes are removed when
another session lists peers, and a normal exit removes the session's own
files.

This is local messaging between processes of one OS user, not a security
boundary. Any such process can already read the same sessions' files and Rex
panes. Messages are limited to 64 KiB, and a sender waits at most five
seconds for an answer.
