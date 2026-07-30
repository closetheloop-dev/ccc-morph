# e2e: open the notes hub (Ctrl-B N), add a note from inside the picker with `a`
# (a scripted $EDITOR writes it), see it saved and rendered, then return. Exercises
# the notes-hub add flow and the picker's rendered UI end to end.
Require ccc-morph
Require target
Set Width 1200
Set Height 600
Set WaitTimeout 15s
Output out/notes.gif

# Start from an empty notes store so the picker shows exactly this run's note.
Hide
Type `rm -rf "$XDG_CONFIG_HOME/ccc-morph/notes"`
Enter
Show

Type "ccc-morph -- target"
Enter
Wait+Screen /READY/
Ctrl+B
Type "n"
Wait+Screen /ccc-morph notes \[active\]/
Type "a"
Wait+Screen /e2e note alpha/
Wait+Screen /note saved/
Wait+Screen /a add note/
Type "q"
Wait+Screen /SIZE:/
