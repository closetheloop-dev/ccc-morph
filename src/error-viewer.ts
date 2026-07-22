import type { ActionError } from "./types";

type ViewerControls = {
  pauseChild: () => void;
  resumeChild: () => void;
};

function visible(value: string): string {
  return (
    value
      // biome-ignore lint/suspicious/noControlCharactersInRegex: escaping the ESC byte for display is the point
      .replace(/\x1b/g, "\\x1b")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: rendering control bytes visibly is the point
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, (character) => {
        return `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`;
      })
  );
}

export class ErrorViewer {
  readonly #controls: ViewerControls;
  readonly #errors: ActionError[] = [];
  #active = false;
  #unseen = false;
  #index = 0;
  #scroll = 0;

  constructor(controls: ViewerControls) {
    this.#controls = controls;
  }

  get active(): boolean {
    return this.#active;
  }

  // True while errors have been retained that the user has not opened yet.
  get unseen(): boolean {
    return this.#unseen;
  }

  add(error: ActionError): void {
    this.#errors.push(error);
    if (this.#active) {
      // The viewer is on screen, so the new error is rendered and seen now.
      this.#index = this.#errors.length - 1;
      this.#scroll = 0;
      this.render();
    } else {
      this.#unseen = true;
    }
  }

  open(): boolean {
    if (this.#errors.length === 0 || this.#active) return false;
    this.#unseen = false;
    this.#active = true;
    this.#index = this.#errors.length - 1;
    this.#scroll = 0;
    this.#controls.pauseChild();
    this.render();
    return true;
  }

  close(): void {
    if (!this.#active) return;
    this.#active = false;
    process.stdout.write("\x1b[0m\x1b[2J\x1b[H");
    this.#controls.resumeChild();
  }

  resize(): void {
    if (this.#active) this.render();
  }

  handleInput(bytes: Uint8Array): void {
    const input = new TextDecoder().decode(bytes);
    if (input === "\x1b[A") {
      this.#move(-1);
      return;
    }
    if (input === "\x1b[B") {
      this.#move(1);
      return;
    }

    for (const byte of bytes) {
      if (byte === 0x71 || byte === 0x1b) {
        this.close(); // q / Escape
        return;
      }
      if (byte === 0x6a) this.#move(1); // j
      if (byte === 0x6b) this.#move(-1); // k
      if (byte === 0x6e) this.#select(1); // n
      if (byte === 0x70) this.#select(-1); // p
    }
  }

  render(): void {
    if (!this.#active) return;
    const error = this.#errors[this.#index];
    if (!error) return;
    const rows = Math.max(process.stdout.rows ?? 24, 5);
    const bodyRows = rows - 3;
    const lines = this.#format(error);
    const maxScroll = Math.max(0, lines.length - bodyRows);
    this.#scroll = Math.min(this.#scroll, maxScroll);
    const body = lines.slice(this.#scroll, this.#scroll + bodyRows);

    const header = ` ccc-morph action error ${this.#index + 1}/${this.#errors.length} `;
    const footer = ` j/k scroll  n/p error  q/Esc return  ${this.#scroll + 1}-${Math.min(this.#scroll + bodyRows, lines.length)}/${lines.length} `;
    process.stdout.write(
      `\x1b[0m\x1b[2J\x1b[H\x1b[7m${header}\x1b[0m\r\n${body.join("\r\n")}\x1b[${rows};1H\x1b[7m${footer}\x1b[0m`,
    );
  }

  #format(error: ActionError): string[] {
    const status = error.message
      ? `spawn error: ${error.message}`
      : `exit: ${error.exitCode ?? "unknown"}${error.signal ? ` (${error.signal})` : ""}`;
    const sections = [
      `time: ${error.occurredAt.toISOString()}`,
      `binding: ${error.binding}`,
      `command: ${error.argv.map((part) => JSON.stringify(part)).join(" ")}`,
      status,
      "",
      `stdout${error.stdoutTruncated ? " (truncated)" : ""}:`,
      visible(error.stdout) || "(empty)",
      "",
      `stderr${error.stderrTruncated ? " (truncated)" : ""}:`,
      visible(error.stderr) || "(empty)",
    ];
    return sections.flatMap((section) => section.split(/\r?\n/));
  }

  #move(delta: number): void {
    const error = this.#errors[this.#index];
    if (!error) return;
    const bodyRows = Math.max((process.stdout.rows ?? 24) - 3, 1);
    const maxScroll = Math.max(0, this.#format(error).length - bodyRows);
    this.#scroll = Math.max(0, Math.min(maxScroll, this.#scroll + delta));
    this.render();
  }

  #select(delta: number): void {
    this.#index = Math.max(0, Math.min(this.#errors.length - 1, this.#index + delta));
    this.#scroll = 0;
    this.render();
  }
}
