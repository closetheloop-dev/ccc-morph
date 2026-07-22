# e2e: Ctrl-B F runs a background command that fails; the wrapper paints a
# persistent reverse-video failure notice that keeps the "for details" hint.
Require ccc-morph
Require target
Set Width 1200
Set Height 600
Set WaitTimeout 12s
Output out/run-failure.gif

Type "ccc-morph -- target"
Enter
Wait+Screen /READY/
Ctrl+B
Type "f"
Wait+Screen /ctrl-b f failed/
Wait+Screen /for details/
