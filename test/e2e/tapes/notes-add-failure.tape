# e2e (regression): a direct `add-note` action (Ctrl-B A) whose store write FAILS
# must report "note failed" and keep the wrapper running -- not abort it with an
# unhandled rejection. Without the catch in TerminalSession.#captureNote the wrapper
# dies, so "note failed" never renders and this tape times out. The picker add path
# (#createNoteInPicker, already guarded) is covered by notes.tape.
#
# The failure is forced deterministically: make the notes store path a regular FILE,
# so NoteStore.add()'s recursive mkdir of that directory throws EEXIST -- structural,
# not a permission bit, so it holds even as root in the CI image.
Require ccc-morph
Require target
Set Width 1200
Set Height 600
Set WaitTimeout 15s
Output out/notes-add-failure.gif

Hide
Type `rm -rf "$XDG_CONFIG_HOME/ccc-morph/notes" && : > "$XDG_CONFIG_HOME/ccc-morph/notes"`
Enter
Show

Type "ccc-morph -- target"
Enter
Wait+Screen /READY/
# Direct add-note: the scripted $EDITOR writes the note, then the store write fails.
Ctrl+B
Type "a"
# The failure surfaces as a status notice, not a crash.
Wait+Screen /note failed/
# ...and the wrapper is still alive: a keystroke still reaches the child (x = 0x78).
Type "x"
Wait+Screen /DATA:78/
