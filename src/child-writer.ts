// Buffers writes to the child PTY. A PTY may accept only part of a write when its input
// buffer is full; the remainder is queued and flushed on the terminal's `drain` event. This
// also makes *full delivery* observable via `drained()`, so a caller that must not lose work
// -- note insertion, which archives the inserted notes -- can wait until the bytes actually
// reach the child and preserve the notes if the child exits with the paste still queued.

// Writes up to `bytes.length` bytes to the underlying PTY, returning the count accepted now.
export type TerminalWrite = (bytes: Uint8Array) => number;

export class ChildWriter {
  readonly #write: TerminalWrite;
  #queue: Uint8Array[] = [];
  #closed = false;
  #drainWaiters: Array<(delivered: boolean) => void> = [];

  constructor(write: TerminalWrite) {
    this.#write = write;
  }

  // Enqueue bytes for the child, preserving order. Anything not accepted immediately is
  // queued for the next flush(). Returns false only when the writer is closed (child gone)
  // or nothing was given, so the caller knows the bytes were not accepted at all.
  write(bytes: Uint8Array): boolean {
    if (this.#closed || bytes.length === 0) return false;
    if (this.#queue.length > 0) {
      // Order matters: never jump ahead of already-queued bytes.
      this.#queue.push(bytes.slice());
      return true;
    }
    const written = this.#write(bytes);
    if (written < bytes.length) this.#queue.push(bytes.subarray(Math.max(0, written)).slice());
    if (this.#queue.length === 0) this.#settle(true);
    return true;
  }

  // Flush as much of the queue as the PTY now accepts (call on the `drain` event). Stops at
  // the first short write, leaving the rest queued for the next drain.
  flush(): void {
    if (this.#closed) return;
    while (this.#queue.length > 0) {
      const bytes = this.#queue[0]!;
      const written = this.#write(bytes);
      if (written < bytes.length) {
        this.#queue[0] = bytes.subarray(Math.max(0, written)).slice();
        return;
      }
      this.#queue.shift();
    }
    this.#settle(true);
  }

  // True while bytes are still queued (not yet delivered to the child).
  get pending(): boolean {
    return this.#queue.length > 0;
  }

  // Resolves true once the queue is fully delivered to the child, or false if the writer is
  // closed (the child exited) while bytes are still queued. An empty queue is already
  // delivered, so it resolves true even after close.
  drained(): Promise<boolean> {
    if (this.#queue.length === 0) return Promise.resolve(true);
    if (this.#closed) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => this.#drainWaiters.push(resolve));
  }

  // The child/PTY is gone: reject any pending delivery waits and refuse further writes.
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#settle(false);
  }

  #settle(delivered: boolean): void {
    if (this.#drainWaiters.length === 0) return;
    const waiters = this.#drainWaiters;
    this.#drainWaiters = [];
    for (const resolve of waiters) resolve(delivered);
  }
}
