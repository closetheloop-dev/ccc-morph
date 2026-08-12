# Configuration

Configuration has two layers:

1. **Global config**: `$XDG_CONFIG_HOME/ccc-morph/config.toml` (falling back to
   `~/.config/ccc-morph/config.toml`). Its `[[bindings]]` apply to **every** wrapped
   program. A missing file is allowed and means there are no global bindings.
2. **App configs**: `$XDG_CONFIG_HOME/ccc-morph/apps/<name>.toml` (same `~/.config`
   fallback). Overrides for one program, discovered automatically and layered on top
   of the globals.

In normal (discovery) mode, ccc-morph resolves the app name (an explicit `--app
NAME`, else the wrapped executable's basename) and applies `apps/<name>.toml` if it
exists, or the app config whose `aliases` include that name. This path convention is
identical on Linux and macOS.

`--config FILE` uses only that file as the configuration. It does no app discovery
and cannot be combined with `--app` (a missing explicit file is an error).
`--no-config` disables all configuration.

`--check-config FILE` validates a global config file without launching anything: it
exits `0` when the file parses (including the duplicate-encoding check) and non-zero
with a message otherwise.

`--ensure-defaults` creates the global config if it is absent and appends any missing
default bindings (error viewer, notes hub) to it. It parses the config first, so it skips
a default whose action is already bound or whose keys are already in use, appends the rest
as text (leaving your comments and bindings intact), and never writes a config that would
not parse. The installer runs it.

```toml
version = 1
sequence_timeout_ms = 1000
max_error_output_bytes = 262144
notice_timeout_ms = 10000
completion_notice_timeout_ms = 5000
start_notice_timeout_ms = 3000
notes_child_mode = "pause"

[[bindings]]
keys = ["ctrl-b", "e"]
action = { type = "show-errors" }

[[bindings]]
keys = ["ctrl-b", "r"]
action = { type = "run", argv = ["sh", "-lc", "your-command"] }
```

These global bindings apply to every wrapped program. Program-specific behavior,
for example Codex's single/double Ctrl-D handling, lives in an app config (see
[App configs](#app-configs)).

The matcher waits up to `sequence_timeout_ms` while input is a possible shortcut
prefix. Consequently, a lone Ctrl-B in the example is delayed briefly while ccc-morph
waits to see whether it begins a bound sequence such as Ctrl-B E; if the next key
does not match, both are forwarded unchanged.

Bracketed-paste bodies are always forwarded without shortcut matching.

## App configs

An app config (`apps/<name>.toml`) overrides the global configuration when the
wrapped program's basename, or one of the app config's `aliases`, matches `<name>`.
It uses the same binding and action syntax, plus optional program-specific limits and
aliases:

```toml
version = 1
sequence_timeout_ms = 1000
max_error_output_bytes = 262144
notice_timeout_ms = 10000
completion_notice_timeout_ms = 5000
start_notice_timeout_ms = 3000
notes_child_mode = "pause"
inherit_globals = true

# Extra executable basenames that also select this app config.
aliases = ["codex-cli"]

# Remove one inherited global sequence entirely.
[[unbind]]
keys = ["ctrl-b", "r"]

# App bindings replace byte-equivalent global bindings and add new sequences.
[[bindings]]
keys = ["ctrl-d"]
action = { type = "ignore" }
```

Omitted limits inherit from the global configuration. App bindings replace
byte-equivalent inherited bindings. Set `inherit_globals = false` to start with no
inherited bindings; in that mode `unbind` is invalid.

Discovery is case-sensitive and uses `COMMAND[0]`'s lexical basename without
resolving symlinks or inspecting arguments. App config names and aliases must be
executable basenames without `/`, and a program may not match more than one app
config.

## Key names

Bindings and `send` actions accept:

- Printable single characters, such as `"g"` or `"/"`
- `ctrl-a` through `ctrl-z`, plus `ctrl-@`, `ctrl-[`, `ctrl-\\`,
  `ctrl-]`, `ctrl-^`, `ctrl-_`, and `ctrl-space`
- Conventional numeric aliases `ctrl-2` through `ctrl-8`, plus `ctrl-?`
- A single-character Alt key, such as `alt-j`
- `enter`, `tab`, `shift-tab` (also `backtab`), `backspace`, `escape`, and `space`
- `up`, `down`, `left`, `right`, `home`, `end`, `insert`,
  `delete`, `page-up`, `page-down`, and `f1` through `f12`
- Common aliases `ins`, `del`, `pgup`, and `pgdn`
- Application-cursor variants `app-up`, `app-down`, `app-left`, `app-right`,
  `app-home`, and `app-end`
- Xterm-style `shift-`, `alt-`, and `ctrl-` modifiers, in any combination, for
  navigation keys and `f1` through `f12` (for example `ctrl-left` or
  `shift-alt-f5`)
- Exact bytes as `hex:1b5b41`

Terminal protocols sometimes encode different-looking key combinations identically.
The configuration is rejected if two bindings compile to the same byte sequence. Raw
hexadecimal bindings are available for terminal-specific sequences. Combinations
such as `ctrl-enter`, `shift-enter`, and `ctrl-tab` have no universal legacy-terminal
encoding and are deliberately not guessed. Use `ccc-morph --inspect-key`, then bind
the reported `hex:` value when your terminal supports one of them.

## Choosing keys

Whatever a binding intercepts is taken from the wrapped program, so pick keys it is
unlikely to need. The examples use `Ctrl-B` as a two-key leader (`Ctrl-B`, then
another key) for familiarity, but treat that as a starting point and tune it to what
you run:

- **A terminal multiplexer may claim the leader first.** tmux owns `Ctrl-B` and
  screen owns `Ctrl-A` by default, and consume them before ccc-morph ever sees the
  keys. If you wrap programs inside tmux/screen, either remap the multiplexer's prefix
  or choose a leader it does not use.
- **Double-tap sequences** (e.g. `["ctrl-d", "ctrl-d"]`) are the most robust: a single
  press still reaches the program (after `sequence_timeout_ms`), so the key is never
  permanently stolen; only the deliberate double press is intercepted.

Note that `Ctrl+<punctuation>` combinations like `Ctrl+;` are **not** representable in
standard terminals (they send the bare character); use a `ctrl-<letter>` leader,
`alt-<char>`, or an explicit `hex:` sequence instead.

## Actions

Send named keys:

```toml
action = { type = "send", keys = ["ctrl-l"] }
```

Send UTF-8 text or exact hexadecimal bytes:

```toml
action = { type = "send", text = "/status\r" }
action = { type = "send", bytes = "04" }
```

Run a background command:

```toml
action = { type = "run", argv = ["git", "status", "--short"] }
```

Background commands receive no stdin. Their output is discarded on success. When one
starts, a brief bottom-row status (`<key> started`) appears and clears itself after
`start_notice_timeout_ms` (default 3000 ms, overridable per app) or when the command
finishes. When one finishes cleanly it shows a brief bottom-row status (`<key> done in
<elapsed>`) that clears itself after `completion_notice_timeout_ms` (default 5000 ms,
overridable per app). A spawn error, signal, or nonzero exit instead produces a bottom-row failure
notice and stores bounded stdout/stderr for the error viewer. The failure notice
persists: if the wrapped program paints over it, it re-appears whenever the output
pauses, until you open the error viewer; a long failure reason is truncated with an
ellipsis so the "— <key> for details" hint stays visible. Repeated presses do not run
multiple copies of the same binding concurrently; a bottom-row notice reports that the
previous run is still in progress, and clears itself after `notice_timeout_ms` (default
10000 ms, overridable per app), prompting the wrapped program to repaint the row. Use
`["sh", "-lc", "..."]` explicitly when shell syntax is wanted.

Open the error viewer or terminate the wrapped process:

```toml
action = { type = "show-errors" }
action = { type = "quit" }
```

Consume a shortcut without sending anything to the wrapped process:

```toml
action = { type = "ignore" }
```

In the viewer, use j/k or arrow keys to scroll, n/p to select another error, and q or
Escape to return.

Open the notes hub, or open the editor directly to add a note:

```toml
action = { type = "show-notes" }
action = { type = "add-note" }
```

The default binding is `show-notes` on Ctrl-B N: it opens the picker, which is the hub for
everything notes. `add-note` is still available if you want a direct "new note" leader key.
A note is saved only if you write the file in the editor; quitting without saving (for
example vim's `:q!`) discards it, and saving an empty buffer discards it too.

While the notes hub, response history, or editor is open, `notes_child_mode` controls the wrapped
program. `"pause"` freezes it (with `SIGSTOP`) so it cannot repaint over the modal; `"continue"`
leaves it running. `"pause"` is the **global** default, which protects programs that stream raw,
append-only output (a bare shell, `tail -f`) from losing what they print while a modal is open. The
bundled `apps/claude.toml` and `apps/codex.toml`, however, set `notes_child_mode = "continue"`,
because both are full-screen TUIs that redraw cleanly on close. So a normally installed Claude Code or
Codex session runs with `"continue"`; the `"pause"` default applies to other programs and to any app
without that override. Set it in the global config or per app.

Set `source = "output"` on `add-note` to open the editor pre-filled with the wrapped program's
recent output. For a known program that is the agent's latest message (Claude Code and Codex,
read from its session transcript); for anything else it is the ANSI-stripped terminal buffer.
You land in the editor with that text ready to trim, and whatever you keep becomes the note:

```toml
action = { type = "add-note", source = "output" }
```

Inside the picker, a three-row footer separates the keys. **Scroll** the current note with
less/vim keys: `j`/`k` a line, `d`/`u` a half page, `f`/`b` a full page, `g`/`G` to the
top/bottom (`Ctrl-D`/`Ctrl-U`, `Ctrl-F`/`Ctrl-B`, and `Page Up`/`Page Down` work too).
**Create**: `a` adds a note, `c` captures the program's recent output into a note (see
`source = "output"` above), `C` opens the response history — a list+preview of the wrapped
program's recent responses (and, for Claude Code / Codex in plan mode, its plans, labelled
`plan:`) — where `↑`/`↓` select, the scroll keys page a long entry, and `Enter` captures the
selected one into a note; and `e` edits the current note in your editor. **Manage**: the arrow keys move between notes, `Space`
marks them and `Enter` inserts the marked notes into the wrapped program (archiving them),
`Tab` switches between active and archived notes, `D` (Shift-D) deletes, `r` restores an
archived note, and `q` or `Escape` returns. Timestamps are shown in local time.

Response capture (`c` and `C`) reads the wrapped program's own session transcript, so it must know
which session that is. It works for a fresh session and when you resume by session id (`claude
--resume <id>`, `codex resume <id>`) or resume the most recent session (`claude --continue`, `codex
resume --last`). When you resume through the **interactive picker** (bare `claude --resume`, or
`codex resume` with no id), ccc-morph cannot tell which past session you selected, so it will not
guess, rather than risk surfacing a different conversation: `c` captures from the current terminal
buffer instead of the transcript, and `C` opens with no history entries. Use an explicit id or
`--continue` / `--last` when you want history for a resumed session.

For a deterministic Codex resume (`codex resume <id>` or `codex resume --last`), ccc-morph resolves
the transcript from Codex's local thread index when that internal database is present and
compatible, and otherwise falls back to scanning the rollout metadata. That index is an internal
Codex detail, not a stable interface, so any absence or incompatibility silently uses the scan.

Capture assumes **one wrapped agent session per working directory**. It identifies the session's
transcript as the one that appears after ccc-morph launches; it cannot always tell that apart from a
transcript created by a *different* Claude Code or Codex process started in the same directory at
about the same time. So if you run two agents concurrently in one directory, `c`/`C` may show the
other one's response. Run one agent per directory when you rely on capture.

## Notes storage

Notes are saved under the config directory, in `$XDG_CONFIG_HOME/ccc-morph/notes/` (falling back to
`~/.config/ccc-morph/notes/`), the same base directory as `config.toml`.

Notes are **per workspace**: one file holds the notes for one working directory, named after that
directory (a readable slug of the path plus a short hash), for example
`home-me-project-1a2b3c4d.jsonl`. The workspace is the wrapped program's current directory, so Claude
Code and Codex started in the same folder share its notes, while a different folder gets its own file.

Each file is JSONL. The first line is a workspace header
(`{"type":"workspace","version":1,"path":"<directory>"}`), validated on load so a file is never read
for the wrong workspace; every later line is one note
(`{"type":"note","id":...,"text":...,"createdAt":...,"archivedAt":...}`, timestamps in ISO 8601).

Archiving a note (mark it with `Space`, then `Enter` to insert it into the wrapped program) is a soft
delete: the line stays in the file with `archivedAt` set and can be brought back with `r` from the
archived view (`Tab` switches views). `D` (Shift-D) removes a note for good. Files are written
atomically with owner-only permissions (`0600`, directory `0700`), and a lock serializes concurrent
writers so two wrapped programs in the same directory do not clobber each other's notes.
