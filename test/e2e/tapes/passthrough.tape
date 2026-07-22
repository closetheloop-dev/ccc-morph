# e2e: bytes typed by the user flow through the wrapper to the child unchanged.
Require ccc-morph
Require target
Set Width 1200
Set Height 600
Set WaitTimeout 12s
Output out/passthrough.gif

Type "ccc-morph -- target"
Enter
Wait+Screen /READY/
Type "x"
Wait+Screen /DATA:78/
