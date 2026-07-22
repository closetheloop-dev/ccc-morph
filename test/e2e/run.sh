#!/usr/bin/env bash
# Run the ccc-morph rendered-screen e2e tapes with vhs.
#
# Local use (needs vhs + ttyd on PATH):
#   bun run build:local                       # -> dist/ccc-morph
#   CCC_MORPH_BIN=$PWD/dist/ccc-morph test/e2e/run.sh
#
# In the e2e Docker image, ccc-morph is already on PATH and this is the entrypoint.
#
# It runs every tape (never stops at the first failure), captures each tape's
# output to out/<tape>.log, prints a PASS/FAIL + timing summary, and exits
# nonzero if any tape failed. On a failure it does a "debug re-run" of that tape
# with the Wait+Screen assertions replaced by fixed Sleeps so vhs finalizes a
# watchable out/<tape>-debug.gif of what actually happened on screen.

set -uo pipefail

cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"   # test/e2e/

# --- resolve ccc-morph + target onto PATH ------------------------------------
linkdir="$(mktemp -d)"
ln -sf "$PWD/target" "$linkdir/target"
if [ -n "${CCC_MORPH_BIN:-}" ]; then
  ln -sf "$(CDPATH= cd -- "$(dirname -- "$CCC_MORPH_BIN")" && pwd)/$(basename -- "$CCC_MORPH_BIN")" "$linkdir/ccc-morph"
fi
export PATH="$linkdir:$PATH"
export XDG_CONFIG_HOME="$PWD/xdg"

for tool in ccc-morph target vhs; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: '$tool' not found on PATH (set CCC_MORPH_BIN?)" >&2; exit 2; }
done

# --- fresh artifact dir (clear contents; out/ may be a bind mount in CI) ------
mkdir -p out
find out -mindepth 1 -exec rm -rf {} + 2>/dev/null || true

# --- run every tape ----------------------------------------------------------
fail=0
total_start=$SECONDS
for tape in tapes/*.tape; do
  name="$(basename "$tape" .tape)"
  start=$SECONDS
  if vhs "$tape" >"out/$name.log" 2>&1; then
    printf 'PASS  %-16s %ss\n' "$name" "$((SECONDS - start))"
  else
    fail=1
    printf 'FAIL  %-16s %ss   -> out/%s.log\n' "$name" "$((SECONDS - start))" "$name"
    # Debug re-run: drop the timing-out assertions so vhs finalizes a video.
    debug="out/$name-debug.tape"
    sed -E -e 's/^Wait\+Screen.*/Sleep 2s/' \
           -e "s#^Output .*#Output out/$name-debug.gif#" "$tape" >"$debug"
    vhs "$debug" >"out/$name-debug.log" 2>&1 || true
  fi
done

echo "e2e total: $((SECONDS - total_start))s"
[ "$fail" -eq 0 ] && echo "all tapes passed" || echo "some tapes FAILED (see out/*.log and out/*-debug.gif)"
exit "$fail"
