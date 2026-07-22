# e2e image: vhs (bundles ttyd + headless Chromium + ffmpeg) plus the compiled
# linux-x64 ccc-morph binary. Runs the rendered-screen tapes via run.sh.
#
# Build context is this directory (test/e2e/), NOT the repo root, so the staged
# binary and artifacts stay out of the top-level build context. Stage the
# linux-x64 binary at test/e2e/ccc-morph first (gitignored), then:
#
#   docker build --target export -o type=local,dest=./out .   # -> out/linux-x64/ccc-morph
#   cp out/linux-x64/ccc-morph test/e2e/ccc-morph
#   docker build -f test/e2e/Dockerfile -t ccc-morph-e2e test/e2e
#   docker run --rm -v "$PWD/e2e-out:/e2e/out" ccc-morph-e2e

# Pinned to a released tag; bump deliberately.
FROM ghcr.io/charmbracelet/vhs:v0.11.0

# bash for target's raw-mode read loop; coreutils for stty/mktemp. (base is Debian.)
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash coreutils \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /e2e
COPY . /e2e/
RUN install -m 0755 /e2e/ccc-morph /usr/local/bin/ccc-morph \
 && rm -f /e2e/ccc-morph \
 && chmod +x /e2e/target /e2e/run.sh

ENTRYPOINT ["/e2e/run.sh"]
