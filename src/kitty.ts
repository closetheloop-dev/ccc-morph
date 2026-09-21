import { concatBytes } from "./keys";

const encoder = new TextEncoder();

// Kitty keyboard protocol progressive-enhancement flags.
export const KITTY_DISAMBIGUATE = 1; // Escape and ctrl/alt combinations become CSI-u under this flag
export const KITTY_REPORT_EVENT_TYPES = 2;
export const KITTY_REPORT_ALTERNATE_KEYS = 4;
export const KITTY_REPORT_ALL_KEYS = 8; // every key (incl. plain letters/Enter/Tab) becomes CSI-u
export const KITTY_REPORT_ASSOCIATED_TEXT = 16;

const decoder = new TextDecoder();
const CARRY_LIMIT = 64;
const EMPTY = new Uint8Array(0);
// Total bytes of mode/screen controls retained for one modal's replay before the log is
// declared overflowed. Only Kitty keyboard-mode controls and alternate-screen switches
// count — never the child's regular output, which is suppressed and discarded. A real
// program emits a negligible number of these during a modal, so this cap (256 KiB, tens of
// thousands of mode changes) is never approached by legitimate or accidentally-echoed
// content; reaching it means a program is flooding controls. The session then makes a safe,
// cross-platform overflow transition (reset the outer terminal from the exposed snapshot and
// terminate) rather than growing the heap without bound or continuing with divergent state.
const REPLAY_LIMIT = 262144;

// A snapshot of both per-screen keyboard-mode stacks, the currently selected buffer,
// and every alternate-screen private mode currently set (so cleanup can reset them
// all). Used to reset the terminal from the state it was actually left in.
export type ScreenModes = { main: number[]; alt: number[]; active: Screen; altSetModes: number[] };
type Screen = "main" | "alt";

// The private-mode numbers that switch to the alternate screen (h) or back (l). Each
// is an independent action: ANY of them reset returns to the main buffer, regardless
// of which others were set.
const ALT_SCREEN_MODES = new Set([47, 1047, 1049]);

// Tracks the Kitty keyboard mode the wrapped child has negotiated, by observing the
// child's OUTPUT for the mutating sequences:
//   CSI > flags u          push flags onto the active screen's stack
//   CSI < [n] u            pop n entries (default 1)
//   CSI = flags ; mode u   set (1) / or (2) / and (3) the top entry
// Kitty keeps INDEPENDENT stacks for the main and alternate screens, so this also
// observes alternate-screen switches (CSI ? 47|1047|1049 h/l) and applies mutations
// to the active screen. current() returns the top of the active screen's stack
// (0 = legacy). A pure observer: it never alters the output, which the session writes
// verbatim, so byte order is preserved. Chunk-split safe via a small carry buffer.
//
// While a modal suppresses the child's visible output, startRecording()/stopRecording()
// capture the child's mode/screen control sequences so they can be replayed to the
// terminal verbatim on close — reproducing its exact state (keyboard stacks, buffer
// switches, cursor save/restore) rather than a lossily-diffed approximation.
export class KeyboardModeStack {
  #main: number[] = [];
  #alt: number[] = [];
  #active: Screen = "main"; // the buffer selected by the LAST applicable set/reset action
  #altSetModes: number[] = []; // alt-screen private modes currently set (for cleanup), in order
  #recording: Uint8Array[] | null = null; // ordered controls captured behind a modal
  #recordingBytes = 0; // total bytes recorded this modal (checked against the replay limit)
  #recordingOverflowed = false;
  #carry = new Uint8Array(0);
  readonly #recordingLimit: number;

  constructor(options?: { recordingLimit?: number }) {
    this.#recordingLimit = options?.recordingLimit ?? REPLAY_LIMIT;
  }

  #stack(): number[] {
    return this.#active === "alt" ? this.#alt : this.#main;
  }

  current(): number {
    const stack = this.#stack();
    return stack.length > 0 ? stack[stack.length - 1]! : 0;
  }

  // A copy of both stacks, the selected buffer, and every set alternate-screen mode,
  // taken when a modal starts suppressing child output. resetSequence() and the
  // session's exposed-flag computation use it as the state the terminal was left in.
  snapshot(): ScreenModes {
    return {
      main: [...this.#main],
      alt: [...this.#alt],
      active: this.#active,
      altSetModes: [...this.#altSetModes],
    };
  }

  // Begin capturing the child's mode/screen control sequences (a modal is now
  // suppressing its visible output).
  //
  // Begin capturing the child's mode/screen control sequences (a modal is now suppressing
  // its visible output). Retention is bounded by the replay limit; see recordingOverflowed.
  startRecording(): void {
    this.#recording = [];
    this.#recordingBytes = 0;
    this.#recordingOverflowed = false;
  }

  // Whether the recorded log has exceeded the replay limit. The session polls this while a
  // modal is open and, when it turns true, makes a safe overflow transition (reset the outer
  // terminal from the exposed snapshot and terminate) — a cross-platform action that neither
  // grows the heap without bound nor continues with divergent terminal state. Once
  // overflowed, further controls are dropped, so the retained log stays bounded by the limit.
  recordingOverflowed(): boolean {
    return this.#recordingOverflowed;
  }

  // The complete ordered log of mode/screen controls the child emitted while suppressed,
  // to bring the terminal up to the child's current state at modal close. Replayed
  // VERBATIM (reproducing every hidden buffer switch and its cursor-save/clear side
  // effects, in order) — never a lossy final-state reconstruction, so the terminal ends in
  // exactly the state the observer tracked. Bounded by the replay limit (an overflow is
  // handled by the session before close, so this returns the whole retained log). An
  // incomplete control still in the carry is NOT included — feed() holds it and emits the
  // whole control when it completes, so no partial prefix is ever written.
  stopRecording(): Uint8Array {
    const parts = this.#recording ?? [];
    this.#recording = null;
    this.#recordingBytes = 0;
    this.#recordingOverflowed = false;
    return parts.length > 0 ? concatBytes(parts) : EMPTY;
  }

  // Discard an in-progress recording without replaying it (a hard shutdown mid-modal);
  // the terminal is reset separately via resetSequence().
  discardRecording(): void {
    this.#recording = null;
    this.#recordingBytes = 0;
    this.#recordingOverflowed = false;
  }

  // Bytes that return the user's shell (the main screen) to legacy encoding from the
  // given exposed state: clear the alternate screen's stack (entering it via a NON-saving
  // action, 47, so a saved cursor is not clobbered), leave it by resetting EVERY set
  // alternate-screen mode in reverse order (so e.g. 1049's cursor restore runs on the
  // child's original save), and clear the main screen's stack. Written at shutdown so a
  // killed child that never popped — even one whose controls were suppressed behind a
  // modal — cannot leave the terminal, or a later program's alt buffer, enhanced or on a
  // mismatched mode.
  resetSequence(state: ScreenModes): Uint8Array {
    const parts: string[] = [];
    const tempEnter = state.active !== "alt" && state.alt.length > 0;
    if (tempEnter) parts.push("\x1b[?47h"); // non-saving temp entry to clear the alt stack
    if (state.alt.length > 0) parts.push("\x1b[<u".repeat(state.alt.length));
    // Reset the temp 47 first (if we added it), then every set mode in reverse order.
    const leaveModes: number[] = [];
    if (tempEnter && !state.altSetModes.includes(47)) leaveModes.push(47);
    leaveModes.push(...[...state.altSetModes].reverse());
    for (const mode of leaveModes) parts.push(`\x1b[?${mode}l`);
    if (state.main.length > 0) parts.push("\x1b[<u".repeat(state.main.length));
    return parts.length > 0 ? encoder.encode(parts.join("")) : EMPTY;
  }

  // Observe the child's output, track its per-screen keyboard-mode stacks, and RETURN
  // the bytes the session should write to the terminal. While a modal is recording,
  // visible output is suppressed (returns empty) and complete mode/screen controls are
  // captured for replay. An incomplete trailing control is always HELD (never emitted
  // partial), so a control is only ever written whole — its suppressed prefix rides out
  // together with its suffix, and an exposed prefix cannot be cancelled by a later
  // modal render because it was never written on its own.
  feed(data: Uint8Array): Uint8Array {
    const suppressed = this.#recording !== null;
    const buf = this.#carry.length > 0 ? concatBytes([this.#carry, data]) : data;
    let i = 0;
    while (i < buf.length) {
      if (buf[i] !== 0x1b) {
        i += 1;
        continue;
      }
      if (i + 1 >= buf.length) break; // lone trailing ESC -> carry from i
      if (buf[i + 1] !== 0x5b) {
        i += 2; // ESC + non-'[' (e.g. Alt/SS3): not a keyboard-mode sequence
        continue;
      }
      let j = i + 2;
      while (j < buf.length && buf[j]! >= 0x20 && buf[j]! <= 0x3f) j += 1;
      if (j >= buf.length) break; // incomplete CSI -> carry from i (held until complete)
      const final = buf[j]!;
      const params = decoder.decode(buf.subarray(i + 2, j));
      let control = false;
      if (final === 0x75 /* 'u' */) {
        const lead = params[0];
        // Only push/pop/set mutate a stack; the `CSI ? flags u` query reply is ignored.
        if (lead === ">" || lead === "<" || lead === "=") {
          this.#apply(params);
          control = true;
        }
      } else if ((final === 0x68 /* 'h' */ || final === 0x6c) /* 'l' */ && params[0] === "?") {
        control = this.#screenSwitch(params.slice(1), final === 0x68);
      }
      if (control && this.#recording !== null && !this.#recordingOverflowed) {
        const seq = buf.slice(i, j + 1);
        this.#recordingBytes += seq.length;
        // Past the limit, stop retaining so the log stays bounded; the session sees
        // recordingOverflowed() and makes its safe overflow transition before close.
        if (this.#recordingBytes > this.#recordingLimit) this.#recordingOverflowed = true;
        else this.#recording.push(seq);
      }
      i = j + 1;
    }
    // Everything up to `carryEnd` is complete and ready; the trailing incomplete
    // sequence (if any) is held. A pathologically long incomplete run is not a short
    // control, so release it rather than buffer unboundedly.
    let carryEnd = i;
    if (buf.length - carryEnd > CARRY_LIMIT) carryEnd = buf.length;
    this.#carry = carryEnd < buf.length ? buf.slice(carryEnd) : new Uint8Array(0);
    // Suppressed (behind a modal): write nothing. Otherwise emit the complete portion.
    return suppressed || carryEnd === 0 ? EMPTY : buf.slice(0, carryEnd);
  }

  // Apply an alternate-screen enter/leave. Each alt-screen private mode is an
  // independent action: entering any selects the alternate buffer, and resetting any
  // returns to the main buffer — the LAST applicable action in the list wins, not a
  // reference count. The set of currently-set modes is tracked separately, only so
  // cleanup can reset all of them. Returns whether the sequence touched an alt mode.
  #screenSwitch(modes: string, enter: boolean): boolean {
    let matched = false;
    for (const value of modes.split(";").map((v) => Number.parseInt(v, 10))) {
      if (!ALT_SCREEN_MODES.has(value)) continue;
      matched = true;
      if (enter) {
        this.#active = "alt";
        if (!this.#altSetModes.includes(value)) this.#altSetModes.push(value);
      } else {
        this.#active = "main";
        const index = this.#altSetModes.indexOf(value);
        if (index >= 0) this.#altSetModes.splice(index, 1);
      }
    }
    return matched;
  }

  #apply(params: string): void {
    const stack = this.#stack();
    const lead = params[0];
    if (lead === ">") {
      stack.push(toFlags(params.slice(1)));
    } else if (lead === "<") {
      let n = Number.parseInt(params.slice(1) || "1", 10);
      if (!Number.isFinite(n) || n < 1) n = 1;
      stack.length = Math.max(0, stack.length - n);
    } else if (lead === "=") {
      const [flagsField, modeField] = params.slice(1).split(";");
      const flags = toFlags(flagsField);
      const mode = Number.parseInt(modeField || "1", 10);
      const top = stack.length > 0 ? stack[stack.length - 1]! : 0;
      const next = mode === 2 ? top | flags : mode === 3 ? top & ~flags : flags;
      if (stack.length > 0) stack[stack.length - 1] = next;
      else stack.push(next);
    }
  }
}

function toFlags(field: string | undefined): number {
  const value = Number.parseInt(field || "0", 10);
  return Number.isFinite(value) ? value : 0;
}
