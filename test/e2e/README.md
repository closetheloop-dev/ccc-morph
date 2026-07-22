# Rendered-screen e2e tests (ttyd + vhs)

These tests run the **compiled** `ccc-morph` binary in a real terminal emulator
(via [vhs](https://github.com/charmbracelet/vhs), which drives ttyd + headless
Chromium) and assert on the **rendered screen** — the reverse-video notice row,
the full-screen error viewer, and the return-from-viewer resize repaint — which
the byte-stream tests in `test/pty.test.ts` cannot see.

They complement, not replace, `test/pty.test.ts`: `Wait+Screen /regex/` can only
assert that expected text *appears* (a timeout = failure), so negative/exact-byte
checks (e.g. a *single* Ctrl-D being swallowed) stay in the Bun-PTY suite.

## Layout

- `target` — the deterministic wrapped program (bash). Echoes each received byte
  as `DATA:<hex>`, prints `SIZE:<rows> <cols>` on SIGWINCH, uses a fixed prompt
  and a throwaway cwd. No Codex, no network, no personal data.
- `xdg/ccc-morph/{config.toml,apps/target.toml}` — the config, loaded via
  `XDG_CONFIG_HOME` (never your real `~/.config`).
- `tapes/*.tape` — one scenario each. Assertions are the `Wait+Screen` lines.
- `run.sh` — runs every tape, writes artifacts + logs to `out/` (gitignored),
  prints PASS/FAIL + timing, and debug-re-runs any failure into `out/<t>-debug.gif`.
- `Dockerfile` — the CI/local container image.

## Run it

Local (needs `vhs` and `ttyd` on PATH):

```sh
bun run build:local                                   # -> dist/ccc-morph
CCC_MORPH_BIN="$PWD/dist/ccc-morph" test/e2e/run.sh
```

Docker (mirrors CI):

```sh
docker build --target export -o type=local,dest=./out .   # -> out/linux-x64/ccc-morph
cp out/linux-x64/ccc-morph test/e2e/ccc-morph             # stage the binary (gitignored)
docker build -f test/e2e/Dockerfile -t ccc-morph-e2e test/e2e
docker run --rm -v "$PWD/e2e-out:/e2e/out" ccc-morph-e2e
```

CI integration is host-specific. The source repository runs these commands from its
build workflow on pushes to master (and on demand); public mirrors should provide an
equivalent job for their hosting platform.
