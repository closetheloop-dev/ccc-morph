import type { ActionError } from "./types";

type FailureHandler = (error: ActionError) => void;
type CompleteHandler = (bindingLabel: string, durationMs: number) => void;
type StartHandler = (bindingLabel: string) => void;

type Capture = {
  text: string;
  truncated: boolean;
};

async function capture(stream: ReadableStream<Uint8Array>, limit: number): Promise<Capture> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let total = 0;
  let truncated = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (kept < limit) {
      const remaining = limit - kept;
      const piece = value.length <= remaining ? value : value.subarray(0, remaining);
      chunks.push(piece.slice());
      kept += piece.length;
    }
    truncated = total > limit;
  }

  const joined = new Uint8Array(kept);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return { text: new TextDecoder().decode(joined), truncated };
}

export class BackgroundActions {
  readonly #limit: number;
  readonly #onFailure: FailureHandler;
  readonly #onComplete: CompleteHandler;
  readonly #onStart: StartHandler;
  readonly #running = new Map<string, Bun.Subprocess>();
  #stopping = false;

  constructor(
    limit: number,
    onFailure: FailureHandler,
    onComplete: CompleteHandler,
    onStart: StartHandler,
  ) {
    this.#limit = limit;
    this.#onFailure = onFailure;
    this.#onComplete = onComplete;
    this.#onStart = onStart;
  }

  run(bindingId: string, bindingLabel: string, argv: string[]): Promise<void> | null {
    if (this.#stopping || this.#running.has(bindingId)) return null;
    return this.#execute(bindingId, bindingLabel, argv);
  }

  shutdown(): void {
    this.#stopping = true;
    for (const process of this.#running.values()) {
      try {
        process.kill("SIGTERM");
      } catch {
        // The process may have exited between iteration and kill.
      }
    }
    this.#running.clear();
  }

  async #execute(bindingId: string, bindingLabel: string, argv: string[]): Promise<void> {
    const startedAt = Date.now();
    let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
      child = Bun.spawn(argv, {
        cwd: process.cwd(),
        env: process.env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      this.#running.set(bindingId, child);
      this.#onStart(bindingLabel);
    } catch (error) {
      this.#onFailure({
        binding: bindingLabel,
        argv,
        occurredAt: new Date(),
        exitCode: null,
        signal: null,
        message: error instanceof Error ? error.message : String(error),
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      });
      return;
    }

    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        capture(child.stdout, this.#limit),
        capture(child.stderr, this.#limit),
      ]);
      if (this.#stopping) return;
      if (exitCode !== 0) {
        this.#onFailure({
          binding: bindingLabel,
          argv,
          occurredAt: new Date(),
          exitCode,
          signal: child.signalCode ?? null,
          message: null,
          stdout: stdout.text,
          stderr: stderr.text,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
        });
      } else {
        this.#onComplete(bindingLabel, Date.now() - startedAt);
      }
    } catch (error) {
      if (!this.#stopping) {
        this.#onFailure({
          binding: bindingLabel,
          argv,
          occurredAt: new Date(),
          exitCode: null,
          signal: null,
          message: error instanceof Error ? error.message : String(error),
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        });
      }
    } finally {
      this.#running.delete(bindingId);
    }
  }
}
