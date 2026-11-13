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
| Bun 1.4.4  | https://github.com/oven-sh/bun/tree/38afee6c84fcf48c0edb2466aa4b27d287a59c30 |
| Bun WebKit | https://github.com/oven-sh/WebKit/tree/d6375c72affe0f70222cdcb45012b10f0bf3a9d5 |
| Bun TinyCC | https://github.com/oven-sh/tinycc/tree/05f0fafaa3be31e31d7b4b5c17dc60f62c991171 |

The Bun source contains the build scripts and the TinyCC patch Bun applies. The
WebKit commit is Bun's exact patched JavaScriptCore/WebKit source.

## Rebuilding and relinking

Bun's source at the commit above contains its build scripts, which fetch the
pinned WebKit and TinyCC sources; point them at your modified source to rebuild
Bun with your changes. Bun's `LICENSE.md`, reproduced in `THIRD_PARTY_NOTICES`,
describes its workflow for building against a local, modified WebKit, and Bun's
source documents its build requirements.

Then check out the exact `ccc-morph` release tag and compile it natively with
the rebuilt runtime, using the project's own build script, which applies its
compile options and version. Put the directory containing the rebuilt `bun`
first on `PATH`:

```sh
PATH="/path/to/rebuilt-bun-dir:$PATH" bun run build:local   # -> dist/ccc-morph
```

Build natively on each desired platform. Do **not** pass a `--target=bun-*`
cross-compilation target (`build:local` does not), because that may select a
prebuilt runtime instead of the locally modified Bun.

If the Bun version or any embedded LGPL component revision changes, update the
pinned commits above before publishing binaries built with the new runtime.
