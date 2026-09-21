import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { BackgroundActions } from "./background-actions";
import { ChildWriter } from "./child-writer";
import { compileBindings } from "./config";
import { ErrorViewer } from "./error-viewer";
import { encodeKeysActive, encodeRawHex, type InputToken, type Key } from "./keys";
import { KeyboardModeStack, type ScreenModes } from "./kitty";
import { InputRouter, ShortcutMatcher } from "./matcher";
import { NoteStore, type WorkspaceNote } from "./note-store";
import { NoteViewer } from "./note-viewer";
import { adapterFor, OutputCapture } from "./output-capture";
import { OutputViewer } from "./output-viewer";
import { NO_RESUME } from "./resume";
import type { ActionError, CompiledBinding, ResolvedConfig, SendAction } from "./types";

const encoder = new TextEncoder();

// After the error viewer closes, the child is resumed on a one-row-smaller PTY
// and the real size is restored only once the child's first output shows it has
// reacted to the shrunken size (plus a short settle delay), so slow renderers
// always observe a genuine size change and repaint fully. If the child never
// writes, the fallback deadline restores the size anyway.
const REDRAW_ACK_MS = 15;
const REDRAW_FALLBACK_MS = 300;

// A persistent failure notice is repainted shortly after the child's output
// pauses, so the child can overwrite it mid-stream but it always comes back
// until the user opens the error viewer. The delay keeps the repaint out of
// the middle of a frame (never splitting a child escape sequence).
const NOTICE_REASSERT_MS = 80;

// How many recent agent responses the browser lists (newest first). Bounds the list on
// long transcripts while keeping plenty of history to scroll back through.
const BROWSE_LIMIT = 30;

function runStty(args: string[]): string {
  const result = Bun.spawnSync(["stty", ...args], {
    stdin: 0,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const detail = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`stty ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

function restoreStty(state: string): void {
  try {
    Bun.spawnSync(["stty", state], {
      stdin: 0,
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    // Best effort during shutdown; there is nowhere safe to report this.
  }
}
function cleanEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function sanitizeStatus(value: string): string {
  return (
    value
      // biome-ignore lint/suspicious/noControlCharactersInRegex: collapsing control bytes to spaces is the point
      .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function clip(value: string, width: number): string {
  if (width <= 1) return "";
  const characters = Array.from(value);
  return characters.length < width ? value : `${characters.slice(0, width - 1).join("")}…`;
}

// Fits a three-part notice into `width` columns while always preserving the fixed
// head and tail: only the variable body is truncated (with an ellipsis). Used so a
// long failure reason never pushes the " — <key> for details" hint off the row. If
// head and tail alone do not fit, degrades to clipping the whole line.
function fitNotice(head: string, body: string, tail: string, width: number): string {
  if (width <= 1) return "";
  const whole = `${head}${body}${tail}`;
  if (Array.from(whole).length <= width) return whole;
  const room = width - Array.from(head).length - Array.from(tail).length;
  if (room >= 2) return `${head}${clip(body, room)}${tail}`;
  if (Array.from(`${head}${tail}`).length <= width) return `${head}${tail}`;
  return clip(whole, width);
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function sendPayload(action: SendAction, flags: number): Uint8Array {
  if (action.keys) return encodeKeysActive(action.keys, flags);
  if (action.text !== undefined) return encoder.encode(action.text);
  return encodeRawHex(action.bytes!);
}

export class TerminalSession {
  readonly #config: ResolvedConfig;
  readonly #command: string[];
  readonly #bindings: CompiledBinding[];
  readonly #background: BackgroundActions;
  readonly #viewer: ErrorViewer;
  readonly #noteStore: NoteStore;
  readonly #notes: NoteViewer;
  readonly #outputs: OutputViewer;
  readonly #capture: OutputCapture;
  // Tracks the Kitty keyboard mode the child has negotiated (observed from its output),
  // so `send` re-encodes keys in that mode and the matcher's decode stays consistent.
  readonly #keyboard = new KeyboardModeStack();
  #child: Bun.Subprocess | null = null;
  #terminal: Bun.Terminal | null = null;
  #router: InputRouter | null = null;
  #matcher: ShortcutMatcher | null = null;
  #savedTerminalState: string | null = null;
  // Buffers writes to the child and makes full delivery observable (see #submitNotes).
  #writer: ChildWriter | null = null;
  #cleaned = false;
  #redrawTimer: ReturnType<typeof setTimeout> | null = null;
  #pendingRestore: { cols: number; rows: number; deadline: number } | null = null;
  #noticeTimer: ReturnType<typeof setTimeout> | null = null;
  #reassertTimer: ReturnType<typeof setTimeout> | null = null;
  #failureNotice: { head: string; body: string; tail: string } | null = null;
  #editorActive = false;
  // Set once a replay-log overflow starts shutdown, so the PTY callback stops processing and
  // the shutdown is idempotent; #overflowExitCode is returned through run().
  #aborting = false;
  #overflowExitCode: number | null = null;
  #notesModalPaused = false;
  #modalTask: Promise<void> | null = null;
  // The child's keyboard-mode state captured when a modal began suppressing output,
  // so the terminal can be reconciled to the child's current mode when the modal
  // closes (the terminal missed any mode changes made behind the modal). It is also
  // the state the terminal is actually left in, so cleanup resets from it.
  #modeStackAtModalOpen: ScreenModes | null = null;

  // All terminal input flows through the one router so it is decoded exactly once
  // (legacy bytes and Kitty CSI-u alike); the router's sink then dispatches decoded
  // keys to the active wrapper viewer or to the shortcut matcher (see #routeKeys).
  readonly #onInput = (chunk: Buffer): void => {
    this.#router?.feed(chunk);
  };

  // Route decoded input. Release and repeat events always go to the matcher so its
  // per-key release bookkeeping stays correct across modal transitions (a press that
  // opened a modal still gets its owed release settled). While a modal owns the
  // screen, a decoded press drives that viewer instead of the matcher — and we tell
  // the matcher to owe that key's release, so the release (which may arrive after the
  // modal closes) is swallowed rather than leaked to the child as an orphan.
  #routeKeys(tokens: InputToken[]): void {
    for (const token of tokens) {
      if (token.kind === "key" && token.event === "press" && this.#modalActive()) {
        this.#dispatchViewerKey(token.key);
        this.#matcher?.oweRelease(token.key);
      } else if (token.kind !== "key" && this.#modalActive()) {
        // Non-key input (mouse, unknown escapes) has no meaning to a viewer; drop it.
      } else {
        this.#matcher?.feedKeys([token]);
      }
    }
  }

  #dispatchViewerKey(key: Key): void {
    if (this.#outputs.active) this.#outputs.handleKey(key);
    else if (this.#notes.active) this.#notes.handleKey(key);
    else if (this.#viewer.active) this.#viewer.handleKey(key);
  }

  // The Kitty flags the OUTER TERMINAL is currently encoding input with. Non-modal
  // this is the child's live mode; while a modal suppresses output the terminal is
  // frozen at the modal-open snapshot, so its flags come from there — not the child's
  // hidden observed mode, which the terminal has not been told about yet.
  #exposedFlags(): number {
    const snapshot = this.#modeStackAtModalOpen;
    if (snapshot === null) return this.#keyboard.current();
    const stack = snapshot.active === "alt" ? snapshot.alt : snapshot.main;
    return stack.length > 0 ? stack[stack.length - 1]! : 0;
  }

  readonly #onResize = (): void => {
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    if (this.#outputs.active) this.#outputs.resize();
    else if (this.#notes.active) this.#notes.resize();
    else if (this.#viewer.active) this.#viewer.resize();
    else {
      // A real resize supersedes a pending redraw restore; it forces the child
      // through a genuine size change on its own. The repaint also erases any
      // transient notice, so its clear timer is dropped too.
      if (this.#redrawTimer !== null) clearTimeout(this.#redrawTimer);
      this.#redrawTimer = null;
      this.#pendingRestore = null;
      if (this.#noticeTimer !== null) clearTimeout(this.#noticeTimer);
      this.#noticeTimer = null;
      this.#terminal?.resize(cols, rows);
    }
  };

  readonly #signalHandlers = new Map<NodeJS.Signals, () => void>();
  readonly #onProcessExit = (): void => {
    this.#restoreOuterTerminal();
  };

  constructor(config: ResolvedConfig, command: string[]) {
    this.#config = config;
    this.#command = command;
    this.#bindings = compileBindings(config);
    this.#viewer = new ErrorViewer({
      pauseChild: () => this.#signalChildGroup("SIGSTOP"),
      resumeChild: () => this.#redrawChild(true),
    });
    this.#noteStore = new NoteStore();
    // Resolved app identity (from --app or alias discovery) so an aliased or wrapped program
    // (e.g. `--app codex -- codex-wrapper`) still picks the right transcript adapter; falls
    // back to the program basename when no app matched.
    const appIdentity = this.#config.appName ?? basename(this.#command[0] ?? "");
    const adapter = adapterFor(appIdentity);
    const resumeIntent = adapter ? adapter.detectResume(this.#command.slice(1)) : NO_RESUME;
    this.#capture = new OutputCapture({
      commandName: appIdentity,
      cwd: process.cwd(),
      resumeLatest: resumeIntent.latest,
      resumeSessionId: resumeIntent.sessionId,
    });
    this.#notes = new NoteViewer(this.#noteStore, {
      close: () => this.#finishNotesModal(),
      submit: (notes) => this.#trackModalTask(this.#submitNotes(notes)),
      edit: (note) => this.#trackModalTask(this.#editNote(note)),
      add: () => this.#trackModalTask(this.#createNoteInPicker()),
      capture: () => this.#trackModalTask(this.#createNoteInPicker(this.#capture.recent())),
      history: () => this.#openHistory(),
    });
    this.#outputs = new OutputViewer({
      // Selecting an item opens the editor pre-filled with it, then lands on the hub.
      select: (text) => this.#trackModalTask(this.#createNoteInPicker(text)),
      // Dismissing the history returns to the notes hub without capturing.
      close: () => this.#notes.refresh(),
    });
    this.#background = new BackgroundActions(
      config.maxErrorOutputBytes,
      (error) => this.#reportFailure(error),
      (label, durationMs) => this.#reportCompletion(label, durationMs),
      (label) => this.#reportStart(label),
    );
  }

  async run(): Promise<number> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("ccc-morph requires both stdin and stdout to be terminals");
    }

    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    const environment = cleanEnvironment();
    const matcher = new ShortcutMatcher(
      this.#bindings,
      this.#config.sequenceTimeoutMs,
      (bytes) => this.#writeChild(bytes),
      (binding) => this.#handleBinding(binding),
    );
    this.#matcher = matcher;
    this.#router = new InputRouter({
      keys: (tokens) => this.#routeKeys(tokens),
      // Bracketed-paste content goes straight to the child, and never into a modal.
      paste: (bytes) => {
        if (!this.#modalActive()) this.#writeChild(bytes);
      },
      beforePaste: () => {
        if (!this.#modalActive()) matcher.flushPending();
      },
      dispose: () => matcher.dispose(),
    });

    try {
      this.#prepareOuterTerminal();
      const child = Bun.spawn(this.#command, {
        cwd: process.cwd(),
        env: environment,
        terminal: {
          cols,
          rows,
          name: environment.TERM ?? "xterm-256color",
          data: (_terminal, data) => {
            // Once an overflow shutdown is underway, stop processing PTY output entirely: the
            // async shutdown owns the terminal from here and will reset and exit.
            if (this.#aborting) return;
            // Capture every byte (even while a modal owns the screen) so `c` can
            // pull the program's recent output on demand, and track the Kitty
            // keyboard mode the child negotiates (a pure observer of the stream).
            this.#capture.feed(data);
            // The observer both tracks the child's mode and returns the bytes to write:
            // it suppresses output behind a modal, and holds an incomplete trailing
            // control until it completes so a control is only ever written whole (its
            // exact byte order preserved). The modal-close replay is emitted separately.
            const output = this.#keyboard.feed(data);
            // The matcher must use the flags the TERMINAL is actually encoding input
            // with (release bookkeeping, app-cursor matching), which during a modal is
            // the frozen snapshot, not the child's hidden observed mode.
            this.#matcher?.setFlags(this.#exposedFlags());
            if (output.length > 0) process.stdout.write(output);
            if (this.#modalActive()) {
              // Safety valve: a program flooding mode/screen controls behind a modal would
              // grow the replay log without bound. At the limit, begin a cross-platform safe
              // shutdown -- reap the child and any editor, reset the outer terminal from the
              // exposed snapshot, and terminate -- rather than grow the heap or continue with
              // divergent state.
              if (this.#keyboard.recordingOverflowed()) this.#beginOverflowShutdown();
              return;
            }
            // First output after the viewer closed: the child has reacted to
            // the shrunken PTY, so the real size can be restored shortly.
            if (this.#pendingRestore !== null) this.#scheduleRestore(REDRAW_ACK_MS);
            // Child output may have painted over an unseen failure notice;
            // re-assert it once the output pauses.
            if (this.#failureNotice !== null && this.#viewer.unseen) this.#scheduleReassert();
          },
          drain: () => this.#writer?.flush(),
        },
      });
      this.#child = child;
      this.#terminal = child.terminal ?? null;
      this.#writer = this.#terminal
        ? new ChildWriter((bytes) =>
            this.#terminal && !this.#terminal.closed ? this.#terminal.write(bytes) : 0,
          )
        : null;
      this.#startInput();
      this.#installSignals();
      const exitCode = await child.exited;
      // The child is gone: fail any pending note-delivery waits before we await the modal
      // task, so #submitNotes stops waiting to drain (and keeps its notes) instead of hanging.
      this.#writer?.close();
      if (this.#modalTask !== null) await this.#modalTask;
      // A replay-log overflow shuts the session down through this normal unwind, returning 1.
      return this.#overflowExitCode ?? exitCode;
    } finally {
      this.#cleanup(this.#aborting);
    }
  }

  #prepareOuterTerminal(): void {
    this.#savedTerminalState = runStty(["-g"]);
    process.on("exit", this.#onProcessExit);
    runStty(["raw", "-echo"]);
  }

  #startInput(): void {
    process.stdin.resume();
    process.stdin.on("data", this.#onInput);
    process.on("SIGWINCH", this.#onResize);
  }

  #installSignals(): void {
    for (const signal of ["SIGHUP", "SIGTERM", "SIGQUIT"] as const) {
      const handler = (): void => {
        try {
          this.#child?.kill(signal);
        } catch {
          this.#cleanup();
        }
      };
      this.#signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }
  }

  #handleBinding(binding: CompiledBinding): void {
    const action = binding.action;
    if (action.type === "ignore") return;
    if (action.type === "send") {
      this.#writeChild(sendPayload(action, this.#keyboard.current()));
      return;
    }
    if (action.type === "run") {
      // A null return means the same binding is still in flight (the shutdown
      // case cannot reach here: cleanup removes the stdin listener first).
      if (this.#background.run(binding.id, binding.label, action.argv) === null) {
        this.#transientNotice(`[ccc-morph] ${binding.label} is still running`);
      }
      return;
    }
    if (action.type === "show-errors") {
      const wasModal = this.#modalActive();
      if (this.#viewer.open()) {
        if (!wasModal) {
          this.#modeStackAtModalOpen = this.#keyboard.snapshot();
          this.#keyboard.startRecording();
        }
        // The errors are seen now: stop re-asserting the failure notice.
        this.#failureNotice = null;
        if (this.#reassertTimer !== null) {
          clearTimeout(this.#reassertTimer);
          this.#reassertTimer = null;
        }
      }
      return;
    }
    if (action.type === "add-note") {
      this.#startNoteEditor(action.source === "output" ? this.#capture.recent() : "");
      return;
    }
    if (action.type === "show-notes") {
      this.#openNotes();
      return;
    }
    if (action.type === "quit") {
      try {
        this.#child?.kill("SIGTERM");
        const timer = setTimeout(() => {
          try {
            this.#child?.kill("SIGKILL");
          } catch {
            // The child exited during the grace period.
          }
        }, 1500);
        timer.unref();
      } catch {
        // The child has already exited.
      }
    }
  }

  #writeChild(bytes: Uint8Array): boolean {
    const terminal = this.#terminal;
    if (!this.#writer || !terminal || terminal.closed || bytes.length === 0) return false;
    return this.#writer.write(bytes);
  }

  #reportFailure(error: ActionError): void {
    this.#viewer.add(error);
    // If the error viewer is already open, add() rendered the failure and marked it seen.
    // Building a persistent notice here would leave stale state that suppresses later
    // completion notices until the viewer is reopened, so stop after recording the error.
    if (this.#viewer.active) return;

    const detailBinding = this.#bindings.find(
      (binding) => binding.action.type === "show-errors",
    )?.label;
    const firstErrorLine = error.stderr.split(/\r?\n/, 1)[0];
    const reason = error.message ?? firstErrorLine ?? `exit ${error.exitCode}`;
    // Failure notices persist: remember the message in parts so child repaints
    // that erase it are countered (see #scheduleReassert), and let it own the
    // row over any pending transient clear. Split so a long reason is truncated
    // without dropping the actionable "— <key> for details" suffix.
    this.#failureNotice = {
      head: `[ccc-morph] ${error.binding} failed: `,
      body: sanitizeStatus(reason || `exit ${error.exitCode}`),
      tail: detailBinding ? ` — ${detailBinding} for details` : "",
    };
    if (this.#noticeTimer !== null) {
      clearTimeout(this.#noticeTimer);
      this.#noticeTimer = null;
    }
    // A modal owns the screen: keep the notice but do not paint over it. It is surfaced when
    // the modal closes and the child is redrawn (#finishNotesModal / #scheduleReassert).
    if (this.#modalActive()) return;
    this.#paintFailureNotice();
  }

  // Writes an already-fitted status line over the terminal's bottom row.
  #writeNoticeRow(text: string): void {
    // Never paint the notice row over a modal that owns the screen (error viewer,
    // notes picker, or an external editor); it belongs over the child only.
    if (this.#modalActive()) return;
    const rows = process.stdout.rows ?? 24;
    process.stdout.write(`\x1b7\x1b[${rows};1H\x1b[7m\x1b[2K${text}\x1b[0m\x1b8`);
  }

  // A plain single-part notice (still-running, completion): clip to the width.
  #paintNotice(message: string): void {
    const columns = process.stdout.columns ?? 80;
    this.#writeNoticeRow(clip(sanitizeStatus(message), columns));
  }

  // The persistent failure notice: fit to the current width, preserving the
  // "— <key> for details" tail, recomputed each paint so it survives resizes.
  #paintFailureNotice(): void {
    const notice = this.#failureNotice;
    if (notice === null) return;
    const columns = process.stdout.columns ?? 80;
    this.#writeNoticeRow(fitNotice(notice.head, notice.body, notice.tail, columns));
  }

  // An informational notice: shown now, cleared again after `durationMs` with a
  // forced child repaint so the row's real content returns.
  #transientNotice(message: string, durationMs: number = this.#config.noticeTimeoutMs): void {
    this.#paintNotice(message);
    if (this.#noticeTimer !== null) clearTimeout(this.#noticeTimer);
    this.#noticeTimer = setTimeout(() => {
      this.#noticeTimer = null;
      this.#clearNotice();
    }, durationMs);
    this.#noticeTimer.unref();
  }

  // A background command just started: flash a quick "started" status. It is
  // replaced by the completion or failure notice when the command finishes.
  #reportStart(label: string): void {
    this.#transientNotice(`[ccc-morph] ${label} started`, this.#config.startNoticeTimeoutMs);
  }

  // A background command finished cleanly: flash a quick status with its elapsed
  // time. An unseen persistent failure notice outranks this transient one.
  #reportCompletion(label: string, durationMs: number): void {
    if (this.#failureNotice !== null) return;
    this.#transientNotice(
      `[ccc-morph] ${label} done in ${formatDuration(durationMs)}`,
      this.#config.completionNoticeTimeoutMs,
    );
  }

  #clearNotice(): void {
    const terminal = this.#terminal;
    // Skip clearing (and its repaint nudge) while a modal owns the screen: the row
    // is the modal's, and a stray SIGWINCH would disturb it.
    if (this.#modalActive() || !terminal || terminal.closed) return;
    const rows = process.stdout.rows ?? 24;
    process.stdout.write(`\x1b7\x1b[${rows};1H\x1b[2K\x1b8`);
    this.#nudgeRepaint();
  }

  #scheduleReassert(): void {
    if (this.#reassertTimer !== null) clearTimeout(this.#reassertTimer);
    this.#reassertTimer = setTimeout(() => {
      this.#reassertTimer = null;
      if (this.#failureNotice === null || this.#modalActive() || !this.#viewer.unseen) return;
      this.#paintFailureNotice();
    }, NOTICE_REASSERT_MS);
    this.#reassertTimer.unref();
  }

  #redrawChild(resume: boolean): void {
    // During an overflow shutdown the modal task may unwind (e.g. the editor was reaped) and
    // reach here, but the terminal must NOT be reconciled from the truncated recording or the
    // diverged observer state: the shutdown resets from the preserved modal-opening snapshot
    // instead. Skip entirely, leaving that snapshot intact for #cleanup.
    if (this.#aborting) return;
    // The modal is closing: the terminal missed the mode/screen controls the child
    // emitted while its output was suppressed. Replay exactly those controls (not the
    // suppressed visible output) so the terminal reproduces the child's current mode
    // and screen state faithfully, in order.
    const snapshot = this.#modeStackAtModalOpen;
    this.#modeStackAtModalOpen = null;
    if (snapshot !== null) {
      const replay = this.#keyboard.stopRecording();
      if (replay.length > 0) process.stdout.write(replay);
      // The terminal now exposes the child's mode again: switch the matcher's flags
      // atomically from the frozen snapshot to the reconciled child state.
      this.#matcher?.setFlags(this.#exposedFlags());
    }
    const terminal = this.#terminal;
    if (!terminal || terminal.closed) {
      if (resume) this.#signalChildGroup("SIGCONT");
      return;
    }
    // Only resume a child the wrapper itself paused. A continue-mode notes modal never
    // stopped the child, so closing it must repaint WITHOUT an unsolicited SIGCONT -- which
    // would otherwise revive a child the user had independently stopped (e.g. Ctrl-Z).
    this.#nudgeRepaint(resume ? () => this.#signalChildGroup("SIGCONT") : undefined);
  }

  // Forces a full child repaint: shrink the PTY one row, then restore the real
  // size once the child's output acknowledges the change (#restoreSize). The
  // optional callback runs between the resize and the SIGWINCH, so the resume
  // path can slot its SIGCONT in the proven order.
  #nudgeRepaint(afterResize?: () => void): void {
    const terminal = this.#terminal;
    if (!terminal || terminal.closed) return;

    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    const temporaryRows = rows > 1 ? rows - 1 : rows;
    const temporaryCols = rows > 1 ? cols : Math.max(1, cols - 1);

    terminal.resize(temporaryCols, temporaryRows);
    afterResize?.();
    this.#signalChildGroup("SIGWINCH");

    this.#pendingRestore = { cols, rows, deadline: Date.now() + REDRAW_FALLBACK_MS };
    this.#scheduleRestore(REDRAW_FALLBACK_MS);
  }

  #scheduleRestore(delayMs: number): void {
    const pending = this.#pendingRestore;
    if (pending === null) return;
    const delay = Math.max(0, Math.min(delayMs, pending.deadline - Date.now()));
    if (this.#redrawTimer !== null) clearTimeout(this.#redrawTimer);
    this.#redrawTimer = setTimeout(() => {
      this.#redrawTimer = null;
      this.#restoreSize();
    }, delay);
    this.#redrawTimer.unref();
  }

  #restoreSize(): void {
    const pending = this.#pendingRestore;
    if (pending === null) return;
    this.#pendingRestore = null;
    const terminal = this.#terminal;
    // A reopened viewer, an open notes modal, or a closed PTY cancels the
    // restore; the next modal close recomputes sizes from the current terminal.
    if (this.#modalActive() || !terminal || terminal.closed) return;
    terminal.resize(pending.cols, pending.rows);
    this.#signalChildGroup("SIGWINCH");
  }

  #modalActive(): boolean {
    return this.#viewer.active || this.#notes.active || this.#outputs.active || this.#editorActive;
  }

  // Open the response history from inside the notes hub: snapshot the wrapped program's
  // recent agent responses (newest first) and hand the screen to the browser. The notes
  // hub has already deactivated itself (its C-key handler), so no child resume happens.
  // Plans are kept regardless of recency (Claude overwrites the plan file, so this is the
  // only way to recover an earlier one); only plain responses are capped to the last N.
  #openHistory(): void {
    const agentItems = this.#capture
      .latestMessages(0)
      .filter((message) => message.role === "agent");
    const keep = new Set(
      agentItems.filter((message) => message.kind !== "plan").slice(-BROWSE_LIMIT),
    );
    const items = agentItems
      .filter((message) => message.kind === "plan" || keep.has(message))
      .reverse();
    this.#outputs.open(items);
  }

  #beginNotesModal(): boolean {
    if (this.#modalActive()) return false;
    this.#modeStackAtModalOpen = this.#keyboard.snapshot();
    this.#keyboard.startRecording();
    this.#notesModalPaused = this.#config.notesChildMode === "pause";
    if (this.#notesModalPaused) this.#signalChildGroup("SIGSTOP");
    return true;
  }

  #finishNotesModal(): void {
    const paused = this.#notesModalPaused;
    this.#notesModalPaused = false;
    process.stdout.write("\x1b[0m\x1b[2J\x1b[H");
    this.#redrawChild(paused);
    // A background command may have failed while the modal owned the screen; its notice was
    // kept but not painted (#reportFailure). Surface it now that the child is back. If the
    // child then repaints over it, #scheduleReassert brings it back.
    if (this.#failureNotice !== null && !this.#modalActive()) this.#paintFailureNotice();
  }

  #openNotes(): void {
    if (!this.#beginNotesModal()) return;
    try {
      this.#notes.open();
    } catch (error) {
      this.#finishNotesModal();
      this.#showStatus(
        `notes unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  #startNoteEditor(prefill = ""): void {
    if (this.#modalTask !== null || !this.#beginNotesModal()) return;
    void this.#trackModalTask(this.#captureNote(prefill));
  }

  #trackModalTask(task: Promise<void>): Promise<void> {
    this.#modalTask = task;
    void task.finally(() => {
      if (this.#modalTask === task) this.#modalTask = null;
    });
    return task;
  }

  // Run $VISUAL/$EDITOR on a temp file seeded with initialText and report the result.
  // The file's mtime is backdated before launch so that "saved" reliably means the
  // editor wrote the file: quitting without writing (e.g. vim :q!) reports saved:false
  // regardless of filesystem timestamp granularity.
  async #runEditor(initialText: string): Promise<{ saved: boolean; text: string; error?: string }> {
    process.stdin.off("data", this.#onInput);
    process.stdin.pause();
    const savedState = this.#savedTerminalState;
    if (savedState !== null) restoreStty(savedState);

    let directory: string | null = null;
    try {
      directory = mkdtempSync(join(tmpdir(), "ccc-morph-note-"));
      const path = join(directory, "note.md");
      writeFileSync(path, initialText, { mode: 0o600 });
      utimesSync(path, new Date(0), new Date(0));
      const stamp = statSync(path).mtimeMs;
      const editor = Bun.spawn(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: this is shell parameter expansion, not JavaScript interpolation
        ["/bin/sh", "-c", 'exec ${VISUAL:-${EDITOR:-vi}} "$1"', "ccc-morph-note-editor", path],
        {
          cwd: process.cwd(),
          env: cleanEnvironment(),
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        },
      );
      const exitCode = await editor.exited;
      if (exitCode !== 0)
        return { saved: false, text: "", error: `editor exited with status ${exitCode}` };
      if (statSync(path).mtimeMs === stamp) return { saved: false, text: "" };
      const text = readFileSync(path, "utf8").replaceAll("\r\n", "\n").replace(/\n$/, "");
      return { saved: true, text };
    } catch (error) {
      return {
        saved: false,
        text: "",
        error: `note editor failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      if (directory !== null) rmSync(directory, { recursive: true, force: true });
      if (this.#savedTerminalState !== null) {
        try {
          runStty(["raw", "-echo"]);
        } catch {
          // Best effort; the modal transition below repaints regardless.
        }
      }
      process.stdin.resume();
      process.stdin.on("data", this.#onInput);
    }
  }

  async #captureNote(prefill = ""): Promise<void> {
    this.#editorActive = true;
    let status = "";
    try {
      const result = await this.#runEditor(prefill);
      if (result.error) status = result.error;
      else if (!result.saved) status = "note discarded";
      else if (result.text.trim().length > 0) {
        await this.#noteStore.add(result.text);
        status = "note saved";
      } else {
        status = "empty note discarded";
      }
    } catch (error) {
      // A NoteStore.add() failure (lock timeout, malformed notes file, permissions,
      // full disk) must not become an unhandled rejection: #trackModalTask voids this
      // task, so an escaping error would terminate the wrapper. Surface it as a status
      // instead, matching #createNoteInPicker.
      status = `note failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.#editorActive = false;
      this.#finishNotesModal();
      if (status) this.#showStatus(status);
    }
  }

  // Create a note from inside the open picker (the `a` key opens an empty editor),
  // then return to the picker.
  async #createNoteInPicker(prefill = ""): Promise<void> {
    this.#editorActive = true;
    let status = "";
    try {
      const result = await this.#runEditor(prefill);
      if (result.error) status = result.error;
      else if (!result.saved) status = "note discarded";
      else if (result.text.trim().length > 0) {
        await this.#noteStore.add(result.text);
        status = "note saved";
      } else {
        status = "empty note discarded";
      }
    } catch (error) {
      status = `note failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.#editorActive = false;
      try {
        this.#notes.refresh(status);
      } catch (error) {
        this.#finishNotesModal();
        this.#showStatus(
          `notes unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  // Re-edit an existing note in the editor, then return to the open picker.
  async #editNote(note: WorkspaceNote): Promise<void> {
    this.#editorActive = true;
    let status = "";
    try {
      const result = await this.#runEditor(note.text);
      if (result.error) status = result.error;
      else if (!result.saved) status = "edit discarded";
      else if (result.text.trim().length === 0) status = "empty edit ignored";
      else if (result.text === note.text) status = "note unchanged";
      else {
        await this.#noteStore.update(note.id, result.text);
        status = "note updated";
      }
    } catch (error) {
      status = `note edit failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.#editorActive = false;
      try {
        this.#notes.refresh(status);
      } catch (error) {
        this.#finishNotesModal();
        this.#showStatus(
          `notes unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  async #submitNotes(notes: WorkspaceNote[]): Promise<void> {
    this.#finishNotesModal();
    await Bun.sleep(60);
    const text = notes
      .map((note) => note.text)
      .join("\n\n")
      .replaceAll("\0", "")
      .replaceAll("\x1b[201~", "\\x1b[201~");
    const payload = encoder.encode(`\x1b[200~${text}\x1b[201~`);
    if (!this.#writeChild(payload)) {
      this.#showStatus("notes were not inserted because the child is no longer available");
      return;
    }
    // Archive only once the paste has actually reached the child. If the child exits with it
    // still queued, keep the notes so a failed insertion does not silently discard them.
    if (this.#writer && !(await this.#writer.drained())) {
      this.#showStatus("notes were not inserted because the child exited before delivery");
      return;
    }
    try {
      await this.#noteStore.archive(notes.map((note) => note.id));
    } catch (error) {
      this.#showStatus(
        `notes inserted but could not be archived: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  #showStatus(message: string): void {
    if (this.#modalActive()) return;
    const rows = process.stdout.rows ?? 24;
    const columns = process.stdout.columns ?? 80;
    process.stdout.write(
      `\x1b7\x1b[${rows};1H\x1b[7m\x1b[2K${clip(`[ccc-morph] ${sanitizeStatus(message)}`, columns)}\x1b[0m\x1b8`,
    );
  }

  #signalChildGroup(signal: NodeJS.Signals): void {
    const child = this.#child;
    if (!child) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // The process may have exited while switching views.
      }
    }
  }

  // Safe shutdown for a replay-log overflow (see the data callback and kitty.ts). Idempotent.
  // It stops accepting PTY output (#aborting), discards the truncated log, and kills the flood
  // SOURCE -- the wrapped child group -- but deliberately does NOT touch an external editor:
  // the editor inherits the real terminal directly, so force-killing it would skip its own
  // teardown (leaving the shell on the editor's alternate screen or in editor-set keyboard/
  // mouse/paste modes the wrapped-child observer never saw). The editor is left to exit
  // normally/user-driven; run()'s `await modalTask` awaits that exit (its finally removes its
  // temp dir and restores the tty), after which #cleanup resets the outer terminal from the
  // preserved modal-opening snapshot and run() returns exit status 1. Killing the child both
  // stops the flood and resolves run()'s `await child.exited`. Cross-platform and
  // ownership-free: it never infers whether the child was independently stopped.
  #beginOverflowShutdown(): void {
    if (this.#aborting) return;
    this.#aborting = true;
    this.#overflowExitCode = 1;
    this.#keyboard.discardRecording(); // drop the truncated log; we reset from the snapshot
    try {
      this.#signalChildGroup("SIGKILL");
    } catch {
      // The child may have already exited.
    }
  }

  #cleanup(overflow = false): void {
    if (this.#cleaned) return;
    this.#cleaned = true;
    this.#background.shutdown();
    this.#writer?.close();
    this.#router?.dispose();
    this.#router = null;
    this.#matcher = null;
    if (this.#redrawTimer !== null) {
      clearTimeout(this.#redrawTimer);
      this.#redrawTimer = null;
    }
    this.#pendingRestore = null;
    if (this.#noticeTimer !== null) {
      clearTimeout(this.#noticeTimer);
      this.#noticeTimer = null;
    }
    if (this.#reassertTimer !== null) {
      clearTimeout(this.#reassertTimer);
      this.#reassertTimer = null;
    }
    this.#failureNotice = null;
    process.stdin.off("data", this.#onInput);
    process.off("SIGWINCH", this.#onResize);
    for (const [signal, handler] of this.#signalHandlers) process.off(signal, handler);
    this.#signalHandlers.clear();
    process.stdin.pause();
    if (this.#outputs.active) this.#outputs.deactivate();
    if (this.#notes.active) this.#notes.deactivate();
    this.#notesModalPaused = false;
    // On overflow, deactivate the error viewer PASSIVELY: its close() would run the resume
    // callback -> #redrawChild, which clears the modal snapshot, replays the retained
    // (truncated) prefix, and reconciles from the observer's post-overflow state. The
    // overflow path instead resets from the preserved modal-opening snapshot below, so it
    // must not fire that callback.
    if (this.#viewer.active) {
      if (overflow) this.#viewer.deactivate();
      else this.#viewer.close();
    }
    // Safety net: return the outer terminal to legacy encoding so the user's shell is
    // not left enhanced. Reset from the state the terminal was actually LEFT IN — a
    // modal snapshot if one is still open (the terminal froze there while suppressed),
    // otherwise the child's live observed state — not merely the child's latest mode,
    // which may have popped behind a modal without the terminal ever seeing it.
    const exposed = this.#modeStackAtModalOpen ?? this.#keyboard.snapshot();
    // Drop any recording still open behind a modal; the reset below returns the terminal
    // to legacy directly, so the captured log is not replayed.
    this.#keyboard.discardRecording();
    const reset = this.#keyboard.resetSequence(exposed);
    if (reset.length > 0) {
      try {
        process.stdout.write(reset);
      } catch {
        // stdout may already be gone during a hard shutdown.
      }
    }
    // Tell the user why the session ended, AFTER the terminal is reset (and, for an editor
    // overflow, after the editor has been reaped and could no longer overwrite this).
    if (overflow) {
      try {
        process.stdout.write(
          "[ccc-morph] terminated: the wrapped program emitted an excessive burst of terminal mode controls.\r\n",
        );
      } catch {
        // stdout may already be gone.
      }
    }
    try {
      this.#terminal?.close();
    } catch {
      // The PTY may already be closed by child exit.
    }
    this.#restoreOuterTerminal();
    this.#terminal = null;
  }

  #restoreOuterTerminal(): void {
    const state = this.#savedTerminalState;
    if (state === null) return;
    this.#savedTerminalState = null;
    process.off("exit", this.#onProcessExit);
    restoreStty(state);
  }
}
