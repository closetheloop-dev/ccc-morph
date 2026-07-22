# Corresponding source for LGPL components

The `ccc-morph` binary embeds the Bun runtime (`bun build --compile`), which
statically links LGPL-licensed components: JavaScriptCore/WebKit (LGPL-2) and
TinyCC (LGPL-2.1). The full LGPL texts accompany the binary as `LGPL-2.0.txt`
and `LGPL-2.1.txt`. This file provides the corresponding source and the
instructions to rebuild the runtime with a modified LGPL library and relink
`ccc-morph` against it, as LGPL requires.

The application side of the combined work is `ccc-morph` itself, whose complete
source is the Git tag this binary was built from (see the release page).

## Exact sources (immutable commits)

| Component  | Source |
| ---        | --- |
| Bun 1.3.14 | https://github.com/oven-sh/bun/tree/0d9b296af33f2b851fcbf4df3e9ec89751734ba4 |
| Bun WebKit | https://github.com/oven-sh/WebKit/tree/5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b |
| Bun TinyCC | https://github.com/oven-sh/tinycc/tree/12882eee073cfe5c7621bcfadf679e1372d4537b |

The Bun source contains the build scripts and the TinyCC patch Bun applies. The
WebKit commit is Bun's exact patched JavaScriptCore/WebKit source.

## Rebuilding Bun with a modified WebKit

```sh
git clone https://github.com/oven-sh/bun.git bun
git -C bun checkout 0d9b296af33f2b851fcbf4df3e9ec89751734ba4

git clone https://github.com/oven-sh/WebKit.git bun/vendor/WebKit
git -C bun/vendor/WebKit checkout \
  5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b

cd bun
bun install --frozen-lockfile
bun run build:release:local
```

## Relinking ccc-morph against the rebuilt runtime

After modifying WebKit and rebuilding Bun, check out the exact `ccc-morph`
release tag and compile it natively with the rebuilt runtime:

```sh
/path/to/bun/build/release-local/bun build src/cli.ts \
  --compile --minify \
  --define 'APP_VERSION="vX.Y.Z"' \
  --outfile ccc-morph
```

Build natively on each desired platform. Do **not** pass a `--target=bun-*`
cross-compilation target during this relinking check, because that may select a
prebuilt runtime instead of the locally modified Bun. Bun's exact source also
documents its host toolchain and local-WebKit build requirements.

If the Bun version or any embedded LGPL component revision changes, update the
pinned commits above and this file before publishing binaries built with the
new runtime.
