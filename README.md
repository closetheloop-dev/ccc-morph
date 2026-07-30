# ccc-morph

`ccc-morph` is a transparent PTY wrapper for interactive terminal programs. It
passes the wrapped program's display and input through normally, while configurable
key sequences can send different input, keep persistent workspace notes, start
background commands, open an error viewer, or terminate the session.

The motivating example is the Codex CLI. Coming from Claude Code, your muscle memory
fires `Ctrl-D Ctrl-D`. On raw Codex the first `Ctrl-D` quits Codex and the second then
closes your shell, so one habit nukes both. Wrap Codex with ccc-morph and the bundled
config, and a stray single `Ctrl-D` is ignored while a deliberate `Ctrl-D Ctrl-D` sends
exactly one `Ctrl-D` to Codex. The habit is safe, and the tool itself is generic: it
works with any interactive program.

## Requirements

- Linux or macOS. Windows works via [WSL2](https://learn.microsoft.com/windows/wsl/) (use the `linux-x64` binary); there is no
  native Windows build.
- An interactive terminal, needed only for shortcut interception. In a script or pipe,
  ccc-morph just runs the wrapped program as is.
- Prebuilt binaries are self-contained. Building from source needs Bun 1.3.14+.

## Install

Prebuilt binaries are self-contained, so the target machine needs no Bun, Node.js, or
Docker.

1. Download `ccc-morph-<version>-<platform>.tar.gz` and `SHA256SUMS.txt` for your
   platform (`linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`) from the
   [releases page](https://github.com/closetheloop-dev/ccc-morph/releases).
2. Optionally verify the download:

   ```sh
   sha256sum -c SHA256SUMS.txt --ignore-missing      # Linux
   shasum -a 256 -c SHA256SUMS.txt --ignore-missing  # macOS
   ```

3. Extract and run the bundled installer:

   ```sh
   tar -xzf ccc-morph-<version>-linux-x64.tar.gz
   less install.sh   # optional: read it first, it does no network access
   ./install.sh
   ```

`install.sh` copies the binary to `~/.local/bin` (override with `INSTALL_DIR=...`),
installs the bundled app configs (Codex and Claude) to `~/.config/ccc-morph/apps/`, and runs
`ccc-morph --ensure-defaults` to create or top up the global
`~/.config/ccc-morph/config.toml` with two default bindings: `Ctrl-B E` (error viewer)
and `Ctrl-B N` (the notes hub). Open the hub to view your notes; inside it, `a` adds a
note and `e` edits. That command parses your config
and appends only missing, non-conflicting defaults, so it never overwrites your settings,
skips a default whose keys you already use, and never leaves an invalid config. The
archive's checksum covers `install.sh` too.

On macOS, `~/.local/bin` is not on the default `PATH`. If the installer reports
that, add the line it prints to your shell profile (`~/.zshrc` for the default
zsh) and restart your shell.

On macOS, if Gatekeeper blocks the binary, clear the download quarantine with
`xattr -d com.apple.quarantine ~/.local/bin/ccc-morph`.

### Upgrading

To upgrade, download and (optionally) verify the new tarball, extract it, and re-run
`./install.sh`. It swaps in the new binary, adds any newly bundled app configs, and re-runs
`ccc-morph --ensure-defaults` to top up the global config with any new default bindings. Your
own settings are never overwritten: an app config you already have under
`~/.config/ccc-morph/apps/` is kept as-is (the installer reports `kept existing ...`), and
`--ensure-defaults` only appends missing, non-conflicting bindings. Note that `--ensure-defaults`
alone only touches the global `config.toml`; it does not install app configs, so re-running
`install.sh` is the way to pick those up.

### Shell alias (optional)

To launch Codex through ccc-morph automatically, add an alias to your shell rc
(`~/.bashrc`, `~/.zshrc`):

```sh
alias codex='ccc-morph -- codex'
```

Arguments pass straight through, so `codex --model o3` becomes `ccc-morph -- codex
--model o3`. Because the `codex` after `--` is a plain argument rather than the command
word, the alias neither recurses nor re-expands. With `apps/codex.toml` installed, this
also gives you the Codex Ctrl-D handling automatically.

Good to know:

- **Piping just works.** When stdin or stdout is not a terminal (for example `echo
  prompt | codex` or `codex --help | less`), ccc-morph can't intercept keys anyway, so
  it runs Codex directly and transparently: no shortcuts, but no error either.
- **Bypass the wrapper** entirely with `command codex` or `\codex` to run Codex without
  ccc-morph even on a terminal.

This needs `ccc-morph` on your `PATH` (the installer uses `~/.local/bin`).

## Usage

```sh
ccc-morph -- codex                      # wrap codex with your config
ccc-morph -- bash                       # wrap any program
ccc-morph --config ./my.toml -- codex   # use one explicit config file
ccc-morph --no-config -- codex          # no config, fully transparent
ccc-morph --app codex -- codex-wrapper  # force the codex app config
ccc-morph --check-config ./my.toml      # validate a config file (exit 0 if valid)
ccc-morph --ensure-defaults             # add any missing default bindings to your config
```

The `--` separator is required. Everything after it is the wrapped command and its
arguments, passed through as an argv array without shell interpolation.

To see the exact bytes your terminal sends for one key combination:

```sh
ccc-morph --inspect-key
# Press the key; output is suitable for a binding such as hex:1b5b5a.
```

See [Configuration](docs/configuration.md) to set up your own shortcuts.

## How it works

```
stdin → InputRouter → ShortcutMatcher → { forward bytes to child | run action }
child PTY output → stdout
```

ccc-morph launches the wrapped command on a real pseudoterminal and passes its display
and input through unchanged, intercepting only the key sequences you configure. The
child inherits the working directory, environment, `TERM`, and terminal dimensions, and
its output is never decoded or re-rendered during normal operation.

Shortcut interception needs a terminal on both stdin and stdout. When either is
redirected (a pipe, a file, a non-interactive shell), there is no PTY to intercept, so
ccc-morph simply runs the wrapped command directly, inheriting stdin/stdout/stderr and
forwarding its exit code, with no bindings applied.

Limitations: Linux and macOS only — no native Windows/ConPTY build, though it runs under
[WSL2](https://learn.microsoft.com/windows/wsl/) (which is a real Linux environment; use the `linux-x64` binary). After the error viewer closes,
programs that ignore terminal resize events may not repaint perfectly until their next
redraw. See [Code layout](docs/development.md#code-layout) for the internals.

## The name

`ccc` is the three C's in **C**laude **C**ode and **C**odex, the two agentic terminal
CLIs this tool was built to bridge. `morph` is what it does: it reshapes key behavior
so switching between them, in either direction, does not fight your muscle memory.

Despite the name, ccc-morph is generic. It can morph any TUI coding platform you use,
or any interactive terminal program at all. Claude Code and Codex are simply the
pairing that named it. If you prefer, you can call it a **C**onfigurable **C**onsole
**C**ompanion instead.

## Documentation

- [Configuration](docs/configuration.md): config layers, app configs, key names, and
  actions.
- [Development](docs/development.md): running from source, building release binaries,
  and the code layout.
- [Contributing](CONTRIBUTING.md): local development and pull-request guidance.
- [Security policy](SECURITY.md): privately report vulnerabilities.

For personal, opinionated notes on how I use it, see [my blog posts](https://closetheloop.dev/tags/ccc-morph).

## License

[MIT](LICENSE)
