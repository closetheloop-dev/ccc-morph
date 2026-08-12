#!/bin/sh
# Network bootstrap installer for ccc-morph — the `curl | bash` entry point.
#
#   curl -fsSL https://raw.githubusercontent.com/closetheloop-dev/ccc-morph/main/scripts/install.sh | bash
#
# There are two installers in this repo, on purpose:
#   * the root install.sh is OFFLINE — it is bundled inside each release tarball
#     and does the real work (copy the binary to ~/.local/bin, install app
#     configs, run `ccc-morph --ensure-defaults`, print PATH hints).
#   * THIS script does only the NETWORK part: detect your OS/arch, download the
#     matching release tarball and SHA256SUMS.txt from GitHub Releases, VERIFY
#     the checksum, extract, and then run the offline install.sh from inside the
#     verified archive. It is never packaged into a tarball; it is served from
#     the repo tree and fetched over the network.
#
# Read it first if you like — pipe it to `less` instead of `bash`.
#
# Environment overrides:
#   CCC_MORPH_VERSION  release to install, e.g. v0.3.0   (default: latest)
#   INSTALL_DIR        where the binary goes    (passed through to install.sh)
#   XDG_CONFIG_HOME    config root              (passed through to install.sh)
set -eu

REPO="closetheloop-dev/ccc-morph"

die() { echo "ccc-morph install: $*" >&2; exit 1; }

# 1. Detect the platform slug. These four must stay in sync with the PLATFORMS
#    list in scripts/package-binaries.sh (that script names the release assets).
os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Linux)  os=linux ;;
  Darwin) os=darwin ;;
  *) die "unsupported OS '$os' — Linux and macOS only (on Windows, use WSL2 and the linux-x64 build)" ;;
esac
case "$arch" in
  x86_64 | amd64)  arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) die "unsupported architecture '$arch' — no prebuilt binary for it" ;;
esac
platform="$os-$arch"

# 2. Pick a downloader: prefer curl, fall back to wget.
if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO "$2" "$1"; }
else
  die "need curl or wget on PATH to download the release"
fi

# 3. Resolve the release base URL. Default: GitHub's 'latest' redirect, which
#    only ever resolves to a *published* (non-draft, non-prerelease) release, so
#    the draft-first release flow in .github/workflows/release.yml is respected.
if [ -n "${CCC_MORPH_VERSION:-}" ]; then
  tag="$CCC_MORPH_VERSION"
  case "$tag" in v*) ;; *) tag="v$tag" ;; esac   # accept 0.3.0 or v0.3.0
  base="https://github.com/$REPO/releases/download/$tag"
else
  base="https://github.com/$REPO/releases/latest/download"
fi

# 4. Work in a temp dir; clean it up no matter how we exit.
tmp=$(mktemp -d "${TMPDIR:-/tmp}/ccc-morph.XXXXXX")
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# 5. Find the archive for this platform via SHA256SUMS.txt. The checksums file
#    names every archive (e.g. ccc-morph-0.3.0-linux-x64.tar.gz), so we learn the
#    exact filename — and thus the version — without parsing any JSON.
fetch "$base/SHA256SUMS.txt" "$tmp/SHA256SUMS.txt" \
  || die "could not download SHA256SUMS.txt from $base — no such release?"
archive=$(awk '{print $2}' "$tmp/SHA256SUMS.txt" | grep -- "-$platform\.tar\.gz$" | head -1)
[ -n "$archive" ] || die "no $platform archive listed in SHA256SUMS.txt"

# 6. Download the archive and verify its checksum against the trusted list.
fetch "$base/$archive" "$tmp/$archive" || die "could not download $archive from $base"
(
  cd "$tmp"
  line=$(grep " $archive\$" SHA256SUMS.txt) || die "no checksum line for $archive"
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s\n' "$line" | sha256sum -c - >/dev/null
  elif command -v shasum >/dev/null 2>&1; then
    printf '%s\n' "$line" | shasum -a 256 -c - >/dev/null
  else
    die "need sha256sum or shasum to verify the download"
  fi
) || die "checksum verification FAILED for $archive — aborting, nothing was installed"
echo "verified $archive"

# 7. Extract and hand off to the offline installer bundled in the verified
#    archive. INSTALL_DIR / XDG_CONFIG_HOME pass through the environment, so this
#    honors the same overrides the offline installer documents.
tar -xzf "$tmp/$archive" -C "$tmp"
[ -f "$tmp/install.sh" ] || die "install.sh missing from $archive (unexpected)"
sh "$tmp/install.sh"
