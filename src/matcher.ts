import type { CompiledBinding } from "./types";

type Forward = (bytes: Uint8Array) => void;
type Match = (binding: CompiledBinding) => void;

function startsWith(pattern: Uint8Array, pending: readonly number[]): boolean {
  if (pending.length > pattern.length) return false;
  for (let index = 0; index < pending.length; index += 1) {
    if (pattern[index] !== pending[index]) return false;
  }
  return true;
}

function pendingStartsWith(pending: readonly number[], pattern: Uint8Array): boolean {
  if (pattern.length > pending.length) return false;
  for (let index = 0; index < pattern.length; index += 1) {
    if (pending[index] !== pattern[index]) return false;
  }
  return true;
}

export class ShortcutMatcher {
  readonly #bindings: readonly CompiledBinding[];
  readonly #timeoutMs: number;
  readonly #forward: Forward;
  readonly #match: Match;
  #pending: number[] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    bindings: readonly CompiledBinding[],
    timeoutMs: number,
    forward: Forward,
    match: Match,
  ) {
    this.#bindings = bindings;
    this.#timeoutMs = timeoutMs;
    this.#forward = forward;
    this.#match = match;
  }

  feed(bytes: Uint8Array): void {
    for (const byte of bytes) {
      this.#pending.push(byte);
      this.#evaluate();
    }
  }

  flushPending(): void {
    this.#clearTimer();
    while (this.#pending.length > 0) {
      const completed = this.#longestCompletedPrefix();
      if (!completed) {
        this.#forward(Uint8Array.from(this.#pending));
        this.#pending = [];
        return;
      }
      this.#pending.splice(0, completed.pattern.length);
      this.#match(completed);
    }
  }

  dispose(): void {
    this.flushPending();
  }

  #evaluate(): void {
    this.#clearTimer();

    while (this.#pending.length > 0) {
      const candidates = this.#bindings.filter((binding) =>
        startsWith(binding.pattern, this.#pending),
      );
      if (candidates.length === 0) {
        const completed = this.#longestCompletedPrefix();
        if (completed) {
          this.#pending.splice(0, completed.pattern.length);
          this.#match(completed);
          continue;
        }
        this.#forward(Uint8Array.of(this.#pending.shift()!));
        continue;
      }

      const exact = candidates.find((binding) => binding.pattern.length === this.#pending.length);
      const hasLonger = candidates.some((binding) => binding.pattern.length > this.#pending.length);
      if (exact && !hasLonger) {
        this.#pending = [];
        this.#match(exact);
        continue;
      }

      this.#timer = setTimeout(() => this.#expire(), this.#timeoutMs);
      return;
    }
  }

  #expire(): void {
    this.#timer = null;
    const exact = this.#bindings.find(
      (binding) =>
        binding.pattern.length === this.#pending.length &&
        startsWith(binding.pattern, this.#pending),
    );
    if (exact) {
      this.#pending = [];
      this.#match(exact);
      return;
    }
    this.flushPending();
  }

  #clearTimer(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #longestCompletedPrefix(): CompiledBinding | undefined {
    let longest: CompiledBinding | undefined;
    for (const binding of this.#bindings) {
      if (
        pendingStartsWith(this.#pending, binding.pattern) &&
        (!longest || binding.pattern.length > longest.pattern.length)
      ) {
        longest = binding;
      }
    }
    return longest;
  }
}

const PASTE_START = Uint8Array.from([0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e]);
const PASTE_END = Uint8Array.from([0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e]);

function isPrefix(value: readonly number[], marker: Uint8Array): boolean {
  if (value.length > marker.length) return false;
  return value.every((byte, index) => marker[index] === byte);
}

/** Keeps bracketed-paste bytes out of shortcut matching. */
export class InputRouter {
  readonly #matcher: ShortcutMatcher;
  readonly #forward: Forward;
  readonly #probeTimeoutMs: number;
  #inPaste = false;
  #probe: number[] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(matcher: ShortcutMatcher, forward: Forward, probeTimeoutMs = 25) {
    this.#matcher = matcher;
    this.#forward = forward;
    this.#probeTimeoutMs = probeTimeoutMs;
  }

  feed(bytes: Uint8Array): void {
    this.#clearTimer();
    for (const byte of bytes) this.#accept(byte);
    if (this.#probe.length > 0)
      this.#timer = setTimeout(() => this.#flushProbe(), this.#probeTimeoutMs);
  }

  dispose(): void {
    this.#clearTimer();
    this.#flushProbe();
    this.#matcher.dispose();
  }

  #accept(byte: number): void {
    const marker = this.#inPaste ? PASTE_END : PASTE_START;
    this.#probe.push(byte);

    while (this.#probe.length > 0 && !isPrefix(this.#probe, marker)) {
      const first = this.#probe.shift()!;
      if (this.#inPaste) this.#forward(Uint8Array.of(first));
      else this.#matcher.feed(Uint8Array.of(first));
    }

    if (this.#probe.length === marker.length) {
      if (!this.#inPaste) this.#matcher.flushPending();
      this.#forward(Uint8Array.from(this.#probe));
      this.#probe = [];
      this.#inPaste = !this.#inPaste;
    }
  }

  #flushProbe(): void {
    this.#clearTimer();
    if (this.#probe.length === 0) return;
    const bytes = Uint8Array.from(this.#probe);
    this.#probe = [];
    if (this.#inPaste) this.#forward(bytes);
    else this.#matcher.feed(bytes);
  }

  #clearTimer(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
