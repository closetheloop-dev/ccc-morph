# e2e: Ctrl-B E opens the full-screen error viewer for the failed command; q
# returns and the wrapper forces the child through a real resize (SIZE: repaint).
Require ccc-morph
Require target
Set Width 1200
Set Height 600
Set WaitTimeout 12s
Output out/error-viewer.gif

Type "ccc-morph -- target"
Enter
Wait+Screen /READY/
Ctrl+B
Type "f"
Wait+Screen /ctrl-b f failed/
Ctrl+B
Type "e"
Wait+Screen /ccc-morph action error/
Wait+Screen /q\/Esc return/
Type "q"
Wait+Screen /SIZE:/
