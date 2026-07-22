# Cross-compiles ccc-morph for all release platforms with a pinned Bun
# toolchain.
#
# Used by the CI build/release workflows, and runnable locally:
#   docker buildx build --build-arg VERSION=v0.1.0 --target export \
#     -o type=local,dest=./out .
# drops out/<platform>/ccc-morph onto the host (scratch export stage =
# binaries only, no image to run).
#
# VERSION is baked into the binary via --define APP_VERSION (src/cli.ts falls
# back to "dev" when absent). Lint, typecheck, and the full test suite
# (including the PTY integration tests) gate the compile.
#
# Only Linux and macOS targets are built: ccc-morph drives the child via a
# real PTY and uses `stty`, so there is no Windows/ConPTY target.

FROM docker.io/oven/bun:1.3.14 AS build
WORKDIR /app

COPY package.json bun.lock tsconfig.json biome.jsonc ./
RUN bun install --frozen-lockfile

# Warm Bun's cross-compile runtime cache in a source-independent layer, so the
# per-target runtimes (the "Downloading ..." during compile) are fetched once
# and reused. With CI layer caching this layer is restored, so real builds do
# no runtime downloads.
RUN printf 'export {};\n' > /tmp/warm.ts \
 && for t in linux-x64 linux-arm64 darwin-x64 darwin-arm64; do \
      bun build /tmp/warm.ts --compile --target=bun-$t --outfile "/tmp/warm-$t" >/dev/null; \
    done \
 && rm -f /tmp/warm.ts /tmp/warm-*

COPY src ./src
COPY test ./test
COPY examples ./examples
COPY apps ./apps
# .gitignore is needed by biome (vcs.useIgnoreFile in biome.jsonc). Copy it here,
# NOT next to the dependency files above: it changes often and would otherwise
# bust the `bun install` + runtime-warm-up layers, forcing a full re-download.
COPY .gitignore ./
RUN bun run lint && bun run typecheck && bun test

ARG VERSION=dev
RUN set -eux; \
    DEF="APP_VERSION=\"${VERSION}\""; \
    for t in linux-x64 linux-arm64 darwin-x64 darwin-arm64; do \
      bun build src/cli.ts --compile --minify \
        --no-compile-autoload-dotenv --no-compile-autoload-bunfig \
        --target=bun-$t \
        --define "$DEF" --outfile "out/$t/ccc-morph"; \
    done

# A transparent wrapper must not let Bun inject project-local runtime config
# into the wrapped command. Exercise the host-compatible release binary from a
# directory containing both autoload sources so a missing compile flag fails the
# build.
RUN set -eux; \
    test_dir="$(mktemp -d)"; \
    printf 'CCC_MORPH_DOTENV_SENTINEL=loaded\n' > "$test_dir/.env"; \
    printf '[run]\npreload = ["./preload.ts"]\n' > "$test_dir/bunfig.toml"; \
    printf 'process.env.CCC_MORPH_BUNFIG_SENTINEL = "loaded";\n' > "$test_dir/preload.ts"; \
    cd "$test_dir"; \
    /app/out/linux-x64/ccc-morph -- sh -c \
      'test -z "${CCC_MORPH_DOTENV_SENTINEL+x}" && test -z "${CCC_MORPH_BUNFIG_SENTINEL+x}"'; \
    rm -rf "$test_dir"

FROM scratch AS export
COPY --from=build /app/out /
