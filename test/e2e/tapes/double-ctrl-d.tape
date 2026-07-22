# e2e: a deliberate Ctrl-D Ctrl-D collapses to exactly one Ctrl-D (0x04) at the
# child. (That a *single* Ctrl-D is swallowed is an absence check, covered by
# test/pty.test.ts, not assertable via Wait+Screen.)
Require ccc-morph
Require target
Set Width 1200
Set Height 600
Set WaitTimeout 12s
Output out/double-ctrl-d.gif

Type "ccc-morph -- target"
Enter
Wait+Screen /READY/
Ctrl+D
Ctrl+D
Wait+Screen /DATA:04/
