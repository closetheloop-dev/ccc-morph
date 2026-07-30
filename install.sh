#!/bin/sh
# Offline installer for ccc-morph, bundled inside each release archive.
#
# It does NO network access: it only copies files already present in this
# extracted, checksum-verified archive. Read it before running if you like —
# that is the whole point of shipping it in the tarball.
#
#   ./install.sh
#
# Environment overrides:
#   INSTALL_DIR       where the binary goes (default: ~/.local/bin)
#   XDG_CONFIG_HOME   config root          (default: ~/.config)
set -eu

# Directory this script (and the rest of the archive) lives in.
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

bin_dir="${INSTALL_DIR:-$HOME/.local/bin}"
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/ccc-morph"

# 1. Install the binary. Write a temp file beside the target and rename it into
#    place: an in-place `cp` over a running ccc-morph fails with "Text file busy"
#    (ETXTBSY), but rename(2) swaps the directory entry to a fresh inode, so a
#    running copy keeps its old one and the swap is atomic.
mkdir -p "$bin_dir"
tmp=$(mktemp "$bin_dir/ccc-morph.XXXXXX")
trap 'rm -f "$tmp"' EXIT
cp "$here/ccc-morph" "$tmp"
chmod 0755 "$tmp"
mv -f "$tmp" "$bin_dir/ccc-morph"
trap - EXIT
echo "installed $bin_dir/ccc-morph"

# 2. Install the bundled app configs (codex, claude, ...), never overwriting an existing one.
mkdir -p "$config_dir/apps"
for app_config in "$here"/apps/*.toml; do
  name="$(basename "$app_config")"
  if [ -e "$config_dir/apps/$name" ]; then
    echo "kept existing $config_dir/apps/$name"
  else
    cp "$app_config" "$config_dir/apps/$name"
    echo "installed $config_dir/apps/$name"
  fi
done

# 3. Create or top up the global config with the default bindings. The binary parses
#    the existing config, appends only missing, non-conflicting defaults (preserving
#    your comments and bindings), validates the result, and never overwrites your
#    settings. All the logic lives in `ccc-morph --ensure-defaults`.
"$bin_dir/ccc-morph" --ensure-defaults

# 4. PATH hint + sanity check. If bin_dir is not on PATH (common on macOS, where
#    ~/.local/bin is not on the default PATH), print the exact line to add and the
#    right rc file for the user's shell. It does not edit any config itself.
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *)
    if [ "$bin_dir" = "$HOME/.local/bin" ]; then
      path_line='export PATH="$HOME/.local/bin:$PATH"'
    else
      path_line="export PATH=\"$bin_dir:\$PATH\""
    fi
    case "$(basename -- "${SHELL:-sh}")" in
      zsh)  rc="~/.zshrc" ;;
      # macOS bash reads ~/.bash_profile for login shells; Linux bash reads ~/.bashrc.
      bash) [ "$(uname -s)" = Darwin ] && rc="~/.bash_profile" || rc="~/.bashrc" ;;
      *)    rc="" ;;
    esac
    echo "note: $bin_dir is not on your PATH; add it to run ccc-morph by name."
    if [ -n "$rc" ]; then
      echo "    echo '$path_line' >> $rc"
      echo "  then restart your shell, or run that export in this session."
    else
      echo "  add to your shell profile:  $path_line"
      echo "  then restart your shell, or run it in this session."
    fi
    ;;
esac

echo
"$bin_dir/ccc-morph" --version
echo "done. try: ccc-morph -- codex"
