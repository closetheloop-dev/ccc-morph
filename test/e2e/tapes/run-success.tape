# e2e: Ctrl-B R runs a background command that succeeds; the wrapper flashes a
# "<key> done in <t>" completion notice on the bottom row.
Require ccc-morph
Require target
Set Width 1200
Set Height 600
Set WaitTimeout 12s
Output out/run-success.gif

Type "ccc-morph -- target"
Enter
Wait+Screen /READY/
Ctrl+B
Type "r"
Wait+Screen /ctrl-b r done in/
