import { BackgroundActions } from "./background-actions";
import { compileBindings } from "./config";
import { ErrorViewer } from "./error-viewer";
import { encodeKeys, encodeRawHex } from "./keys";
import { InputRouter, ShortcutMatcher } from "./matcher";
import type { ActionError, CompiledBinding, SendAction, SessionConfig } from "./types";

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

function sendPayload(action: SendAction): Uint8Array {
  if (action.keys) return encodeKeys(action.keys);
  if (action.text !== undefined) return encoder.encode(action.text);
  return encodeRawHex(action.bytes!);
}

export class TerminalSession {
  readonly #config: SessionConfig;
  readonly #command: string[];
  readonly #bindings: CompiledBinding[];
  readonly #background: BackgroundActions;
  readonly #viewer: ErrorViewer;
  #child: Bun.Subprocess | null = null;
  #terminal: Bun.Terminal | null = null;
  #router: InputRouter | null = null;
  #savedTerminalState: string | null = null;
  #inputQueue: Uint8Array[] = [];
  #cleaned = false;
  #redrawTimer: ReturnType<typeof setTimeout> | null = null;
  #pendingRestore: { cols: number; rows: number; deadline: number } | null = null;
  #noticeTimer: ReturnType<typeof setTimeout> | null = null;
  #reassertTimer: ReturnType<typeof setTimeout> | null = null;
  #failureNotice: { head: string; body: string; tail: string } | null = null;

  readonly #onInput = (chunk: Buffer): void => {
    if (this.#viewer.active) this.#viewer.handleInput(chunk);
    else this.#router?.feed(chunk);
  };

  readonly #onResize = (): void => {
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    if (this.#viewer.active) this.#viewer.resize();
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

  constructor(config: SessionConfig, command: string[]) {
    this.#config = config;
    this.#command = command;
    this.#bindings = compileBindings(config);
    this.#viewer = new ErrorViewer({
      pauseChild: () => this.#signalChildGroup("SIGSTOP"),
      resumeChild: () => this.#resumeChildWithRedraw(),
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
    this.#router = new InputRouter(matcher, (bytes) => this.#writeChild(bytes));

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
            if (this.#viewer.active) return;
            process.stdout.write(data);
            // First output after the viewer closed: the child has reacted to
            // the shrunken PTY, so the real size can be restored shortly.
            if (this.#pendingRestore !== null) this.#scheduleRestore(REDRAW_ACK_MS);
            // Child output may have painted over an unseen failure notice;
            // re-assert it once the output pauses.
            if (this.#failureNotice !== null && this.#viewer.unseen) this.#scheduleReassert();
          },
          drain: () => this.#flushInputQueue(),
        },
      });
      this.#child = child;
      this.#terminal = child.terminal ?? null;
      this.#startInput();
      this.#installSignals();
      return await child.exited;
    } finally {
      this.#cleanup();
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
      this.#writeChild(sendPayload(action));
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
      if (this.#viewer.open()) {
        // The errors are seen now: stop re-asserting the failure notice.
        this.#failureNotice = null;
        if (this.#reassertTimer !== null) {
          clearTimeout(this.#reassertTimer);
          this.#reassertTimer = null;
        }
      }
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

  #writeChild(bytes: Uint8Array): void {
    const terminal = this.#terminal;
    if (!terminal || terminal.closed || bytes.length === 0) return;
    if (this.#inputQueue.length > 0) {
      this.#inputQueue.push(bytes.slice());
      return;
    }
    const written = terminal.write(bytes);
    if (written < bytes.length) this.#inputQueue.push(bytes.subarray(Math.max(0, written)).slice());
  }

  #flushInputQueue(): void {
    const terminal = this.#terminal;
    if (!terminal || terminal.closed) return;
    while (this.#inputQueue.length > 0) {
      const bytes = this.#inputQueue[0]!;
      const written = terminal.write(bytes);
      if (written < bytes.length) {
        this.#inputQueue[0] = bytes.subarray(Math.max(0, written)).slice();
        return;
      }
      this.#inputQueue.shift();
    }
  }

  #reportFailure(error: ActionError): void {
    this.#viewer.add(error);
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
    this.#paintFailureNotice();
  }

  // Writes an already-fitted status line over the terminal's bottom row.
  #writeNoticeRow(text: string): void {
    if (this.#viewer.active) return;
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
    if (this.#viewer.active || !terminal || terminal.closed) return;
    const rows = process.stdout.rows ?? 24;
    process.stdout.write(`\x1b7\x1b[${rows};1H\x1b[2K\x1b8`);
    this.#nudgeRepaint();
  }

  #scheduleReassert(): void {
    if (this.#reassertTimer !== null) clearTimeout(this.#reassertTimer);
    this.#reassertTimer = setTimeout(() => {
      this.#reassertTimer = null;
      if (this.#failureNotice === null || this.#viewer.active || !this.#viewer.unseen) return;
      this.#paintFailureNotice();
    }, NOTICE_REASSERT_MS);
    this.#reassertTimer.unref();
  }

  #resumeChildWithRedraw(): void {
    const terminal = this.#terminal;
    if (!terminal || terminal.closed) {
      this.#signalChildGroup("SIGCONT");
      return;
    }
    this.#nudgeRepaint(() => this.#signalChildGroup("SIGCONT"));
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
    // A reopened viewer or closed PTY cancels the restore; the next viewer
    // close recomputes sizes from the current terminal.
    if (this.#viewer.active || !terminal || terminal.closed) return;
    terminal.resize(pending.cols, pending.rows);
    this.#signalChildGroup("SIGWINCH");
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

  #cleanup(): void {
    if (this.#cleaned) return;
    this.#cleaned = true;
    this.#background.shutdown();
    this.#router?.dispose();
    this.#router = null;
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
    if (this.#viewer.active) this.#viewer.close();
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
