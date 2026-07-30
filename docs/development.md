# Development

Requires Bun (version pinned in `.bun-version`). Install the locked dependencies with
`bun install --frozen-lockfile` to reproduce the tree.

```sh
bun install                     # install dependencies
bun run src/cli.ts -- codex     # run from source
bun test                        # unit + PTY integration tests
bun run typecheck               # tsc --noEmit
bun run lint                    # biome: lint + format check
bun run lint:fix                # biome: apply fixes/formatting
bun run build:local             # compile one host binary into dist/
bun run build                   # Docker cross-compile all release targets into dist/
```

## Building release binaries

The release build runs entirely in Docker. It installs the locked dependencies, runs
linting, strict type checking, and all tests, then compiles the CLI with Bun for every
supported release platform:

```sh
bun run build
./dist/linux-x64/ccc-morph --version
```

The exported executables are `dist/linux-x64/ccc-morph`, `dist/linux-arm64/ccc-morph`,
`dist/darwin-x64/ccc-morph`, and `dist/darwin-arm64/ccc-morph`. Each contains the Bun
runtime and bundled application code, so the target machine does not need Bun, Node.js,
or Docker. For local development only, `bun run build:local` compiles one executable
for the host without Docker.

CI builds use the `Dockerfile` (same targets, pinned toolchain, with lint, typecheck,
and tests as build gates); run it locally with:

```sh
docker buildx build --build-arg VERSION=v0.0.0-local \
  --target export -o type=local,dest=./out .
bash scripts/package-binaries.sh v0.0.0-local   # tar.gz per platform + SHA256SUMS.txt
```

`scripts/package-binaries.sh` packages the cross-compiled binaries into per-platform
`tar.gz` archives that also bundle `install.sh`, the bundled app configs (Codex and Claude),
and the license notices. See the [Install](../README.md#install) section for the end-user flow.

The CI workflows persist BuildKit's layer cache with `actions/cache`, keyed on the
dependency-defining files (`bun.lock`, `package.json`, `tsconfig.json`, `biome.jsonc`,
`.bun-version`, `Dockerfile`). Across source-only commits the base image, `bun install`,
and the cross-compile runtime warm-up layer are restored, so a warm build re-runs only
the lint/typecheck/test gate and the four compiles. The Dockerfile pre-fetches the
per-target Bun runtimes in a source-independent layer so those downloads are cached too.

## Code layout

```
stdin → InputRouter → ShortcutMatcher → { forward bytes to child | run action }
child PTY output → stdout
```

The modules layer from pure to side-effecting:

- **`keys.ts`**: a pure encoder from key names (`ctrl-a`, `alt-j`, `f5`, `hex:…`) to
  byte sequences.
- **`config.ts` / `types.ts`**: load and validate TOML, then resolve the two
  configuration layers (global `config.toml`, then per-app `apps/<name>.toml`) into a
  `ResolvedConfig`. A binding's identity is its terminal byte-encoding, which drives
  overrides and duplicate detection.
- **`matcher.ts`**: `ShortcutMatcher` does incremental prefix matching with a
  `sequence_timeout_ms` timer; `InputRouter` wraps it so bracketed-paste bodies are
  forwarded without shortcut matching.
- **`background-actions.ts` / `error-viewer.ts`**: the side-effecting action handlers,
  which run background commands (capturing failures) and the full-screen error viewer.
- **`session.ts`**: the orchestration hub. It spawns the child, wires stdin/stdout,
  forwards signals, propagates `SIGWINCH` resizes, applies input backpressure, and
  saves/restores terminal state via `stty`.
- **`cli.ts`**: argument parsing and wiring.

The pure layers (`keys`, `matcher`, `config`) are unit-tested; the PTY orchestration is
exercised end-to-end in `test/pty.test.ts`.

## Error viewer redraw

A failure notice intentionally overwrites the terminal's bottom row. The lightweight
error viewer clears the display and pauses the child process group. On return the
child is resumed on a one-row-smaller PTY, and the real size is restored only after
the child's first output shows it has reacted to the shrunken size (with a fallback
deadline for programs that never repaint). The genuine size change forces diff-based
TUI renderers to relayout and repaint the whole frame, however slowly they wake from
the pause. Programs that ignore resize events may not restore their display perfectly
until their next redraw. Exact restoration would require embedding a full terminal
emulator and is outside this version.
