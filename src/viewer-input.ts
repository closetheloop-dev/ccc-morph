export type ViewerInputToken = number | "up" | "down" | "page-up" | "page-down";

const ESCAPE = 0x1b;
const ESCAPE_SEQUENCE_WAIT_MS = 30;

export class ViewerInput {
  readonly #emit: (token: ViewerInputToken) => void;
  readonly #pending: number[] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(emit: (token: ViewerInputToken) => void) {
    this.#emit = emit;
  }

  feed(bytes: Uint8Array): void {
    this.#cancelTimer();
    this.#pending.push(...bytes);
    this.#drain();
  }

  reset(): void {
    this.#cancelTimer();
    this.#pending.length = 0;
  }

  #drain(): void {
    while (this.#pending.length > 0) {
      if (this.#pending[0] !== ESCAPE) {
        this.#emit(this.#pending.shift()!);
        continue;
      }

      if (this.#pending.length === 1) {
        this.#waitForEscapeSequence();
        return;
      }

      const introducer = this.#pending[1];
      if (introducer !== 0x5b && introducer !== 0x4f) {
        this.#emit(this.#pending.shift()!);
        continue;
      }
      if (this.#pending.length === 2) {
        this.#waitForEscapeSequence();
        return;
      }

      const command = this.#pending[2];
      if (command === 0x41 || command === 0x42) {
        this.#pending.splice(0, 3);
        this.#emit(command === 0x41 ? "up" : "down");
        continue;
      }

      // Page Up / Page Down are ESC [ 5 ~ and ESC [ 6 ~ (four bytes).
      if (command === 0x35 || command === 0x36) {
        if (this.#pending.length === 3) {
          this.#waitForEscapeSequence();
          return;
        }
        if (this.#pending[3] === 0x7e) {
          this.#pending.splice(0, 4);
          this.#emit(command === 0x35 ? "page-up" : "page-down");
          continue;
        }
      }

      // Preserve Escape semantics for an unsupported sequence.
      this.#emit(this.#pending.shift()!);
    }
  }

  #waitForEscapeSequence(): void {
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#emit(this.#pending.shift()!);
      this.#drain();
    }, ESCAPE_SEQUENCE_WAIT_MS);
    this.#timer.unref();
  }

  #cancelTimer(): void {
    if (this.#timer === null) return;
    clearTimeout(this.#timer);
    this.#timer = null;
  }
}
